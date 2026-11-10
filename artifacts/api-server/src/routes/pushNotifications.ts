import { Router, type Request, type Response } from "express";
import { logger } from "../lib/logger";
import { readServiceAccount, sendFcmMessage } from "../lib/fcm";
import {
  fetchRecipientPushProfile,
  getPostIdForComment,
  getPostType,
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

// معالجة حمولة الإشعار (بعد التحقق من السر):
// - جدول notifications (أنواع التفاعلات): FCM فقط، بلا مسّ للجدول.
// - جدول messages (رسائل مباشرة): FCM فقط — لا تُنشأ سجلات في جدول
//   الإشعارات العامة، وتحديث تبويب الرسائل يتم عبر Realtime على messages.
export async function processPushNotificationPayload(
  payload: Record<string, unknown>,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const supabase = readSupabaseAdminConfig();
  const serviceAccount = readServiceAccount();
  if (!supabase || !serviceAccount) {
    logger.error("Push notification service is missing Supabase or Firebase secrets.");
    return {
      status: 500,
      body: { success: false, error: "Push notification service is not configured." },
    };
  }

  const table = asText(payload.table).toLowerCase();

  // Webhook على جدول messages: رسائل ومكالمات — إرسال FCM خارجي فقط
  if (table === "messages") {
    if (asText(payload.type).toUpperCase() !== "INSERT") {
      return skipOutcome("Not a messages insert.");
    }
    return deliverMessagePush(
      supabase,
      serviceAccount,
      isRecord(payload.record) ? payload.record : {},
    );
  }

  // صيغة Supabase Webhook لجدول notifications (أنواع التفاعلات غير الرسائل)
  const record = isRecord(payload.record) ? payload.record : payload;
  const isNotificationInsert =
    asText(payload.schema) === "public" &&
    asText(payload.table) === "notifications" &&
    asText(payload.type) === "INSERT";

  const userId = asText(record.user_id);
  if (!userId) {
    return skipOutcome("Notification is missing its recipient.");
  }

  if (!isNotificationInsert && !isRecord(payload.record)) {
    return skipOutcome("Unrecognized payload.");
  }

  const type = asText(record.type).toLowerCase();

  // الرسائل والمكالمات الواردة (message / new_message / chat_message / call /
  // incoming_call / missed_call) لا تدخل الشاشة العامة للإشعارات إطلاقاً:
  // لا تُضَف سجلاتها في جدول notifications، ولا يُرسل لها إشعار عام.
  // إشعارها الخارجي (FCM) يُرسل حصراً من Webhook جدول messages؛
  // والمكالمات تُدار عبر Realtime في CallManager.
  if (["message", "new_message", "chat_message", "call", "incoming_call", "missed_call"].includes(type)) {
    return skipOutcome("Messages and calls are pushed externally via the messages webhook only.");
  }

  const recipient = await loadRecipientDevice(supabase, userId);
  if (!recipient.deviceToken) {
    return skipOutcome("Recipient has no registered device token.");
  }

  // احترام تفضيلات الإشعارات للمستلم
  if (recipient.notificationSettings?.[preferenceCategory(type)] === false) {
    return skipOutcome("Recipient disabled this notification category.");
  }

  // بناء المحتوى (العنوان، النص، مسار الفتح) وإرسال الرسالة إلى FCM
  const commentId = asText(record.comment_id);
  const postIdForComment =
    commentId && ["comment", "reply", "like"].includes(type)
      ? await getPostIdForComment(supabase, commentId)
      : "";
  const content = buildNotificationContent(record, postIdForComment);

  // الريلز تُفتح في مشغّل الريلز الخاص بها: نوع المحتوى يُستنتَج
  // من جدول posts مباشرة (بلا اعتماد على عمود content_kind).
  const targetPostId =
    asText(record.post_id) || postIdForComment || asText(record.reference_id) || asText(record.entity_id);
  let pushUrl = content.url;
  if (["like", "repost"].includes(type) && targetPostId) {
    const postType = await getPostType(supabase, targetPostId);
    if (postType === "reel") {
      pushUrl = `/reels?openReel=${encodeURIComponent(targetPostId)}`;
    }
  }

  const result = await sendFcmMessage(serviceAccount, recipient.deviceToken, {
    data: {
      title: content.title,
      body: content.body,
      url: pushUrl,
      notification_id: asText(record.id),
      type: content.type,
      actor_id: asText(record.actor_id),
      post_id: targetPostId,
      comment_id: commentId,
      call_id: ["call", "incoming_call"].includes(type) ? asText(record.reference_id) : "",
    },
    webpush: { headers: { Urgency: "high" } },
  });

  if (!result.ok) {
    logger.error({ status: result.status, errorBody: result.errorBody }, "FCM send failed");
    return {
      status: 502,
      body: { success: false, error: "Firebase rejected the push notification." },
    };
  }

  return { status: 200, body: { success: true, sent: true } };
}

const skipOutcome = (reason: string): { status: number; body: Record<string, unknown> } => ({
  status: 200,
  body: { success: true, skipped: true, reason },
});

type RecipientDevice = {
  deviceToken: string;
  notificationSettings: Record<string, unknown> | null;
};

async function loadRecipientDevice(
  config: { url: string; serviceRoleKey: string },
  userId: string,
): Promise<RecipientDevice> {
  const profile = await fetchRecipientPushProfile(config, userId);
  return {
    deviceToken: profile?.fcmToken || "",
    notificationSettings: profile?.notificationSettings ?? null,
  };
}

// رسائل مباشرة ومكالمات: إرسال FCM لجهاز المستلم فقط —
// لا إضافة أي سجل في جدول الإشعارات العامة (notifications).
// تحديث المحادثات يبقى عبر اشتراكات Realtime على جدول messages.
async function deliverMessagePush(
  config: { url: string; serviceRoleKey: string },
  serviceAccount: Parameters<typeof sendFcmMessage>[0],
  record: Record<string, unknown>,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const senderId = asText(record.sender_id);
  const recipientId = asText(record.recipient_id);
  const messageContent = asText(record.content);

  if (!recipientId || !senderId || recipientId === senderId) {
    return skipOutcome("Message is missing sender or recipient.");
  }

  // إشارات المكالمات الواردة تُدار عبر Realtime (CallManager) فقط —
  // لا إشعار عام ولا إشعار FCM من هذا المسار.
  if (messageContent.startsWith("[aani-call:v1]")) {
    return skipOutcome("Call signal handled via realtime only.");
  }

  const recipient = await loadRecipientDevice(config, recipientId);
  if (!recipient.deviceToken) {
    return skipOutcome("Recipient has no registered device token.");
  }

  if (recipient.notificationSettings?.messages === false) {
    return skipOutcome("Recipient disabled message notifications.");
  }

  const content = buildNotificationContent({
    ...record,
    type: "message",
    title: "رسالة جديدة",
    body: messageContent,
    url: `/messages/${senderId}`,
  });

  const result = await sendFcmMessage(serviceAccount, recipient.deviceToken, {
    data: {
      title: content.title,
      body: content.body,
      url: content.url,
      message_id: asText(record.id),
      type: "message",
      actor_id: senderId,
      conversation_id: senderId,
    },
    webpush: { headers: { Urgency: "high" } },
  });

  if (!result.ok) {
    logger.error({ status: result.status, errorBody: result.errorBody }, "FCM message push failed");
    return {
      status: 502,
      body: { success: false, error: "Firebase rejected the message push." },
    };
  }

  return { status: 200, body: { success: true, sent: true, channel: "message-fcm-only" } };
}

// التحقق من سرّ الـWebhook (ترويسة x-push-webhook-secret أو Bearer)
function authenticatePushWebhook(req: Request): boolean {
  const expectedSecret = process.env["PUSH_WEBHOOK_SECRET"] || "";
  const providedSecret =
    asText(req.headers["x-push-webhook-secret"]) ||
    asText(req.headers.authorization).replace(/^Bearer\s+/i, "");
  return Boolean(expectedSecret) && constantTimeEquals(providedSecret, expectedSecret);
}

// طباعة بيانات طلب الـWebhook في Console
function logPushWebhookRequest(req: Request): void {
  const payload = isRecord(req.body) ? req.body : null;
  try {
    console.log("=".repeat(64));
    console.log(`📥 Webhook إشعارات — ${req.method} ${req.path}`);
    console.log(`   الوقت: ${new Date().toISOString()}`);
    console.log(
      payload
        ? `   البيانات: ${JSON.stringify(payload, null, 2).slice(0, 4000)}`
        : "   البيانات: (جسم الطلب ليس JSON صالحاً)",
    );
    console.log("=".repeat(64));
  } catch {
    /* طباعة الطلب لا يجب أن تعطّل المعالجة */
  }
}

export async function handlePushWebhook(req: Request, res: Response): Promise<Response> {
  try {
    if (!authenticatePushWebhook(req)) {
      return res.status(401).json({ success: false, error: "Unauthorized" });
    }
    if (!isRecord(req.body)) {
      return res.status(400).json({ success: false, error: "Invalid JSON body." });
    }
    const outcome = await processPushNotificationPayload(req.body);
    return res.status(outcome.status).json(outcome.body);
  } catch (error) {
    logger.error({ err: error }, "send-push-notification failed");
    return res.status(500).json({ success: false, error: "حدث خطأ داخلي في الخادم" });
  }
}

// جميع مسارات الـWebhook المدعومة (تُطبع كاملة في الـConsole عند الإقلاع
// لنسخ أحدها مباشرة إلى إعدادات Webhook في Supabase).
export const PUSH_WEBHOOK_PATHS: readonly string[] = [
  "/api/send-push-notification",
  "/api/push-webhook",
  "/api/webhook",
  "/api/webhook/push",
  "/api/push-notification",
  "/api/notifications/webhook",
  "/webhook",
  "/webhook/push",
  "/push-webhook",
  "/push-notification",
  "/notifications/webhook",
  "/",
];

// المسار الأساسي للـWebhook
router.post("/send-push-notification", (req, res) => {
  void handlePushWebhook(req, res);
});

// مسارات إضافية قبِلها Supabase Webhook وشيكات الاتصال (200 دائماً، بلا 404)
router.post(["/push-webhook", "/webhook", "/push-notification", "/notifications/webhook"], (req, res) => {
  void handlePushWebhook(req, res);
});

router.get(["/push-webhook", "/webhook", "/webhook/push", "/push-notification", "/notifications/webhook"], (_req, res) => {
  res.status(200).json({ success: true, message: "Push webhook endpoint is live." });
});

// مسار مخصص: /api/webhook/push
// يطبع بيانات الطلب في Console، ويعيد 200 OK فوراً،
// ثم يعالج الإشعار (FCM) في الخلفية ويعرض النتيجة في Console.
router.post("/webhook/push", (req, res) => {
  logPushWebhookRequest(req);

  if (!authenticatePushWebhook(req)) {
    return res.status(401).json({ success: false, error: "Unauthorized" });
  }

  if (!readSupabaseAdminConfig() || !readServiceAccount()) {
    logger.error("Push notification service is missing Supabase or Firebase secrets.");
    return res.status(500).json({
      success: false,
      error: "Push notification service is not configured.",
    });
  }

  // استجابة فورية — لا ينتظر Supabase اكتمال الإرسال
  res.status(200).json({ success: true, accepted: true, processed: "in-background" });

  const payload = isRecord(req.body) ? req.body : {};
  void processPushNotificationPayload(payload)
    .then(outcome => {
      console.log(`📤 نتيجة معالجة الـWebhook (${outcome.status}): ${JSON.stringify(outcome.body)}`);
    })
    .catch(error => {
      logger.error({ err: error }, "Background push webhook processing failed");
    });
});

export default router;
