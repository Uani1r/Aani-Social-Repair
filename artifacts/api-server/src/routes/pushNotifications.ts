import { Router, type Request, type Response } from "express";
import { logger } from "../lib/logger";
import { readServiceAccount, sendFcmMessage } from "../lib/fcm";
import {
  fetchRecipientPushProfile,
  getPostIdForComment,
  readSupabaseAdminConfig,
} from "../lib/supabaseAdmin";
import { buildNotificationContent, preferenceCategory } from "../lib/notificationContent";

// Webhook إشعارات Supabase: استقبال سجل الإشعار، جلب رمز جهاز المستلم،
// ثم إرسال الإشعار عبر FCM HTTP v1 وإرجاع { success: true }.

const router = Router();

const asText = (value: unknown): string => (typeof value === "string" ? value.trim() : "");

const constantTimeEquals = (left: string, right: string) => {
  if (!left || left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return difference === 0;
};

type WebhookPayload = {
  type?: unknown;
  table?: unknown;
  schema?: unknown;
  record?: unknown;
  [key: string]: unknown;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

export async function handlePushWebhook(req: Request, res: Response): Promise<Response> {
  try {
    // 1) التحقق من سرّ الـWebhook (ترويسة x-push-webhook-secret أو Bearer)
    const expectedSecret = process.env["PUSH_WEBHOOK_SECRET"] || "";
    const providedSecret =
      asText(req.headers["x-push-webhook-secret"]) ||
      asText(req.headers.authorization).replace(/^Bearer\s+/i, "");
    if (!expectedSecret || !constantTimeEquals(providedSecret, expectedSecret)) {
      return res.status(401).json({ success: false, error: "Unauthorized" });
    }

    // 2) التأكد من إعدادات Supabase وFirebase
    const supabase = readSupabaseAdminConfig();
    const serviceAccount = readServiceAccount();
    if (!supabase || !serviceAccount) {
      logger.error("Push notification service is missing Supabase or Firebase secrets.");
      return res.status(500).json({
        success: false,
        error: "Push notification service is not configured.",
      });
    }

    // 3) قراءة الحمولة: صيغة Supabase Webhook ({ type, table, record }) أو حقول مباشرة
    const payload = req.body as WebhookPayload | undefined;
    if (!isRecord(payload)) {
      return res.status(400).json({ success: false, error: "Invalid JSON body." });
    }

    const record = isRecord(payload.record) ? payload.record : payload;
    const isNotificationInsert =
      asText(payload.schema) === "public" &&
      asText(payload.table) === "notifications" &&
      asText(payload.type) === "INSERT";

    const userId = asText(record.user_id);
    if (!userId) {
      return res
        .status(200)
        .json({ success: true, skipped: true, reason: "Notification is missing its recipient." });
    }

    if (!isNotificationInsert && !isRecord(payload.record)) {
      // حمولة مخصصة (ليست Webhook من Supabase) وبدون معرّف مستلم واضح
      return res
        .status(200)
        .json({ success: true, skipped: true, reason: "Unrecognized payload." });
    }

    // 4) جلب رمز جهاز المستلم من profiles (مع تجربة user_tokens كاحتياط)
    const profile = await fetchRecipientPushProfile(supabase, userId);
    const deviceToken = profile?.fcmToken || "";
    if (!deviceToken) {
      return res
        .status(200)
        .json({ success: true, skipped: true, reason: "Recipient has no registered device token." });
    }

    // 5) احترام تفضيلات الإشعارات للمستلم
    const type = asText(record.type).toLowerCase();
    if (profile?.notificationSettings?.[preferenceCategory(type)] === false) {
      return res
        .status(200)
        .json({ success: true, skipped: true, reason: "Recipient disabled this notification category." });
    }

    // 6) بناء المحتوى (العنوان، النص، مسار الفتح) وإرسال الرسالة إلى FCM
    const commentId = asText(record.comment_id);
    const postIdForComment =
      commentId && ["comment", "reply", "like"].includes(type)
        ? await getPostIdForComment(supabase, commentId)
        : "";
    const content = buildNotificationContent(record, postIdForComment);

    const result = await sendFcmMessage(serviceAccount, deviceToken, {
      data: {
        title: content.title,
        body: content.body,
        url: content.url,
        notification_id: asText(record.id),
        type: content.type,
        actor_id: asText(record.actor_id),
        post_id: asText(record.post_id) || postIdForComment || asText(record.reference_id) || asText(record.entity_id),
        comment_id: commentId,
        call_id: ["call", "incoming_call"].includes(type) ? asText(record.reference_id) : "",
      },
      webpush: { headers: { Urgency: "high" } },
    });

    if (!result.ok) {
      logger.error({ status: result.status, errorBody: result.errorBody }, "FCM send failed");
      return res.status(502).json({ success: false, error: "Firebase rejected the push notification." });
    }

    return res.status(200).json({ success: true, sent: true });
  } catch (error) {
    logger.error({ err: error }, "send-push-notification failed");
    return res.status(500).json({ success: false, error: "حدث خطأ داخلي في الخادم" });
  }
}

// المسار الأساسي للـWebhook
router.post("/send-push-notification", (req, res) => {
  void handlePushWebhook(req, res);
});

// مسارات إضافية قبِلها Supabase Webhook وشيكات الاتصال (200 دائماً، بلا 404)
router.post(["/push-webhook", "/webhook", "/notifications/webhook"], (req, res) => {
  void handlePushWebhook(req, res);
});

router.get(["/push-webhook", "/webhook", "/notifications/webhook"], (_req, res) => {
  res.status(200).json({ success: true, message: "Push webhook endpoint is live." });
});

export default router;
