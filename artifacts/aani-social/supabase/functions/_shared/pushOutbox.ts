/**
 * عامل إرسال notification_outbox إلى أجهزة المستلم عبر FCM HTTP v1.
 *
 * هذا الملف نقي وقابل للاختبار: كل تعامل مع Supabase أو Firebase أو الشبكة
 * يمرّ عبر قوالب تُحقن، فلا شبكة ولا أسرار في الاختبارات.
 *
 * القواعد:
 *   * الحجز بـaani_claim_notification_outbox (FOR UPDATE SKIP LOCKED)، فلا
 *     يعالج عاملان المهمة نفسها.
 *   * لكل جهاز صف تسليم مستقل (notification_outbox_deliveries) بمفتاح فريد
 *     (outbox_id, device_token_id): إعادة المحاولة ترسل فقط لما لم ينجح بعد.
 *   * حمولة FCM تحمل معرّفات ونوعاً وحقول عرض عامة (title, body, url) فقط —
 *     لا نص رسالة ولا محتوى مكالمة ولا وسائط.
 *   * لا تُسجَّل الرموز ولا الأسرار ولا محتوى الرسائل في أي سجل.
 */

export type OutboxTask = {
  id: string;
  recipient_user_id: string;
  event_type: string;
  payload: Record<string, unknown>;
  attempts?: number;
};

export type DeviceTokenRow = {
  id: string;
  token: string;
  platform: string;
  provider: string;
};

export type DeliveryRow = {
  id: string;
  outbox_id: string;
  device_token_id: string;
  status: string;
};

export type SendOutcome = {
  ok: boolean;
  status: number;
  invalidToken?: boolean;
  retryable?: boolean;
  providerMessageId?: string;
  error?: string;
};

export type DeliveryCompletion = {
  id: string;
  /**
   * sent: نجح الإرسال. skipped: رمز غير صالح/جهاز غائب. failed: فشل نهائي.
   * pending: فشل مؤقت — يعود للمحاولة القادمة، والأجهزة التي نجحت لا تُعاد.
   */
  status: 'sent' | 'skipped' | 'failed' | 'pending';
  error?: string;
  providerMessageId?: string;
  revokeToken?: boolean;
};

export type OutboxCompletion = {
  id: string;
  status: 'sent' | 'failed';
  worker: string;
  error?: string;
  providerMessageId?: string;
  retryDelaySeconds?: number;
};

export type LogEntry = Record<string, string | number | boolean | null>;

export interface PushOutboxDeps {
  claim: (worker: string, limit: number) => Promise<OutboxTask[]>;
  ensureDeliveries: (outboxId: string) => Promise<DeliveryRow[]>;
  listPendingDeliveries: (outboxId: string) => Promise<DeliveryRow[]>;
  loadDevices: (deviceIds: string[]) => Promise<DeviceTokenRow[]>;
  send: (device: DeviceTokenRow, message: Record<string, unknown>) => Promise<SendOutcome>;
  completeDelivery: (completion: DeliveryCompletion) => Promise<void>;
  completeOutbox: (completion: OutboxCompletion) => Promise<void>;
  log: (entry: LogEntry) => void;
}

export type BatchSummary = {
  claimed: number;
  sent: number;
  skipped: number;
  failed: number;
  /** مهام لم يُرسل منها شيء لعدم وجود جهاز نشط، وأُعيدت للمحاولة القادمة. */
  rescheduled: number;
  completed: number;
};

const MAX_BATCH = 25;
const MAX_DATA_VALUE = 512;

/**
 * سبب إعادة الجدولة عند غياب أي جهاز نشط للمستلم، وعندها لا تُصنَّف المهمة
 * sent: لا صف تسليم يعني لا دليل تسليم.
 */
export const NO_ACTIVE_DEVICES = 'no_active_devices';

/**
 * سقف محاولات غياب الجهاز: بعدها تُنهى المهمة failed بسبب واضح بدل إعادة
 * جدولة لا تنتهي. السقف متوافق مع سقف backoffSeconds نفسه (10 محاولات).
 */
export const MAX_NO_DEVICE_ATTEMPTS = 10;

const SOCIAL_TITLES: Record<string, { title: string; body: string }> = {
  like: { title: 'إعجاب جديد', body: 'أعجب أحدهم بمحتواك.' },
  story_like: { title: 'إعجاب بقصتك', body: 'أعجب أحدهم بقصتك.' },
  comment: { title: 'تعليق جديد', body: 'علّق أحدهم على منشورك.' },
  reply: { title: 'رد جديد', body: 'ردّ أحدهم على تعليقك.' },
  mention: { title: 'إشارة جديدة', body: 'أشار إليك أحدهم.' },
  repost: { title: 'إعادة نشر', body: 'أعاد أحدهم نشر منشورك.' },
  follow: { title: 'متابع جديد', body: 'بدأ أحدهم بمتابعتك.' },
  follow_request: { title: 'طلب متابعة', body: 'لديك طلب متابعة جديد.' },
  story_reply: { title: 'رد على قصتك', body: 'ردّ أحدهم على قصتك.' },
};

function safeText(value: unknown): string {
  if (typeof value !== 'string') return '';
  return value.trim().slice(0, MAX_DATA_VALUE);
}

/** أنواع المتابعة كما في Shell.tsx وgetNotificationTarget. */
const FOLLOW_TYPES = new Set(['follow', 'new_follower', 'followed', 'started_following', 'follow_accepted']);

/** أنواع تفاعلات القصص (تُفتح داخل عارض القصص). */
const STORY_TYPES = new Set(['story_like', 'story_reply', 'story_mention', 'story_view']);

/** أنواع تُفتح على صفحة المنشور. */
const POST_TYPES = new Set(['like', 'post_like', 'repost', 'mention']);

/**
 * وجهة النقر داخل التطبيق — مسارات التطبيق الفعلية فقط:
 *   * رسالة → /messages/<sender_id>   (Shell.tsx وNotificationsModal.tsx)
 *   * مكالمة → /messages/<sender_id>?openCall=1&callerId=…&callId=… (Shell.tsx)
 *   * متابعة → /profile/<actor_id>
 *   * طلب متابعة → /feed?openFollowRequests=1
 *   * تعليق/رد → /post/<reference_id>?showComments=1
 *   * إعجاب/إعادة نشر/إشارة → /post/<reference_id>
 *   * قصة → /feed?openStoryId=…&openStoryOwner=… (المالك: mention للفاعل،
 *     وغيرها لصاحب الإشعار — كما في getNotificationTarget)
 *   * بلا بيانات كافية → /feed
 */
export function notificationDestination(task: OutboxTask): string {
  const payload = task.payload && typeof task.payload === 'object' ? task.payload : {};
  const eventType = safeText(task.event_type);
  const type = safeText(payload.type).toLowerCase();
  const referenceId = safeText(payload.reference_id);
  const actorId = safeText(payload.actor_id);

  if (eventType === 'message') {
    const senderId = safeText(payload.sender_id);
    return senderId ? `/messages/${encodeURIComponent(senderId)}` : '/feed';
  }

  if (eventType === 'call') {
    const senderId = safeText(payload.sender_id);
    if (!senderId) return '/feed';
    const query = new URLSearchParams({ openCall: '1', callerId: senderId });
    const callId = safeText(payload.call_id);
    if (callId) query.set('callId', callId);
    return `/messages/${encodeURIComponent(senderId)}?${query.toString()}`;
  }

  if (FOLLOW_TYPES.has(type) && actorId) return `/profile/${encodeURIComponent(actorId)}`;
  if (type === 'follow_request') return '/feed?openFollowRequests=1';

  if ((type === 'comment' || type === 'reply') && referenceId) {
    return `/post/${encodeURIComponent(referenceId)}?showComments=1`;
  }

  if (STORY_TYPES.has(type) && referenceId) {
    const ownerId = type === 'story_mention' ? actorId : safeText(task.recipient_user_id);
    if (!ownerId) return '/feed';
    const storyQuery = new URLSearchParams({ openStoryId: referenceId, openStoryOwner: ownerId });
    return `/feed?${storyQuery.toString()}`;
  }

  if (POST_TYPES.has(type) && referenceId) return `/post/${encodeURIComponent(referenceId)}`;

  return '/feed';
}

/** حمولة FCM: معرّفات وحقول عرض فقط، بلا أي نص رسالة أو وسائط. */
export function buildFcmMessage(task: OutboxTask, device: DeviceTokenRow): Record<string, unknown> {
  const payload = task.payload && typeof task.payload === 'object' ? task.payload : {};
  const eventType = safeText(task.event_type);
  const data: Record<string, string> = {
    event_type: eventType,
    platform: safeText(device.platform),
  };

  let title = 'إشعار جديد';
  let body = 'لديك إشعار جديد.';

  if (eventType === 'message') {
    data.type = 'message';
    data.message_id = safeText(payload.message_id);
    data.sender_id = safeText(payload.sender_id);
    title = 'رسالة جديدة';
    body = 'لديك رسالة جديدة.';
  } else if (eventType === 'call') {
    data.type = 'call';
    data.message_id = safeText(payload.message_id);
    data.call_id = safeText(payload.call_id);
    data.mode = safeText(payload.mode);
    title = 'مكالمة واردة';
    body = 'لديك مكالمة واردة.';
  } else {
    const type = safeText(payload.type);
    const copy = SOCIAL_TITLES[type] || { title: 'إشعار جديد', body: 'لديك إشعار جديد.' };
    data.type = type || 'notification';
    data.notification_id = safeText(payload.notification_id);
    data.reference_id = safeText(payload.reference_id);
    title = copy.title;
    body = copy.body;
  }

  // حقول العرض التي يقرأها عامل الخدمة (public/firebase-messaging-sw.js):
  // بلا title/body/url في data يظهر إشعار بعنوان افتراضي ونص فارغ.
  data.title = title;
  data.body = body;
  data.url = notificationDestination(task);

  return {
    token: device.token,
    notification: { title, body },
    data,
    android: { priority: 'high' },
    webpush: { headers: { Urgency: eventType === 'call' ? 'high' : 'normal' } },
  };
}

/** تصنيف رد FCM: نجاح، رمز غير صالح، أو فشل قابل لإعادة المحاولة. */
export function classifyFcmResult(status: number, body: string): SendOutcome {
  const text = typeof body === 'string' ? body.toLowerCase() : '';
  if (status >= 200 && status < 300) {
    const match = /"name"\s*:\s*"([^"]+)"/.exec(body || '');
    return { ok: true, status, providerMessageId: match ? match[1] : undefined };
  }
  if (status === 404 || text.includes('unregistered')) {
    return { ok: false, status, invalidToken: true, error: 'unregistered' };
  }
  if (status === 400 && (text.includes('invalid_argument') || text.includes('registration token'))) {
    return { ok: false, status, invalidToken: true, error: 'invalid_token' };
  }
  if (status === 408 || status === 429 || status >= 500) {
    return { ok: false, status, retryable: true, error: 'transient' };
  }
  return { ok: false, status, error: 'rejected' };
}

/** Backoff للمهمة: 60s ثم 120s ثم 240s… بحد أقصى ساعة. */
export function backoffSeconds(attempts: number): number {
  const attempt = Math.max(1, Math.min(Number(attempts) || 1, 10));
  return Math.min(60 * 2 ** (attempt - 1), 3600);
}

function clampLimit(limit: number): number {
  if (!Number.isFinite(limit) || limit <= 0) return 10;
  return Math.min(Math.floor(limit), MAX_BATCH);
}

/**
 * معالجة دفعة واحدة: حجز، ضمان صفوف التسليم لكل جهاز نشط، إرسال لما لم ينجح
 * بعد فقط، ثم إنهاء المهمة والدفعة.
 */
export async function runPushOutboxBatch(
  deps: PushOutboxDeps,
  worker: string,
  limit = 10,
): Promise<BatchSummary> {
  const summary: BatchSummary = { claimed: 0, sent: 0, skipped: 0, failed: 0, rescheduled: 0, completed: 0 };
  const workerName = safeText(worker);
  if (!workerName) throw new Error('push-outbox: worker name is required');

  const tasks = await deps.claim(workerName, clampLimit(limit));
  summary.claimed = tasks.length;

  for (const task of tasks) {
    // صفوف التسليم هي دليل التسليم: تُنشأ لكل جهاز نشط للمستلم.
    const deliveries = await deps.ensureDeliveries(task.id);
    const pending = await deps.listPendingDeliveries(task.id);
    const attempts = Math.max(1, Number(task.attempts) || 1);

    // لا صف تسليم = لا جهاز نشط: لا إرسال ولا دليل، فلا تُصنَّف المهمة sent.
    if (deliveries.length === 0) {
      const exhausted = attempts >= MAX_NO_DEVICE_ATTEMPTS;
      await deps.completeOutbox({
        id: task.id,
        status: 'failed',
        worker: workerName,
        error: NO_ACTIVE_DEVICES,
        // السياسة نفسها: تأخير المهمة، ثم فشل نهائي بسبب واضح عند السقف.
        retryDelaySeconds: exhausted ? 0 : backoffSeconds(attempts),
      });
      if (!exhausted) summary.rescheduled += 1;
      summary.completed += 1;
      deps.log({
        event: 'outbox_task',
        task_id: task.id,
        event_type: safeText(task.event_type),
        devices: 0,
        pending: 0,
        sent: 0,
        skipped: 0,
        failed: 0,
        rescheduled: exhausted ? 0 : 1,
        reason: NO_ACTIVE_DEVICES,
      });
      continue;
    }

    const deviceIds = Array.from(new Set(pending.map(delivery => delivery.device_token_id)));
    const devices = deviceIds.length ? await deps.loadDevices(deviceIds) : [];
    const deviceById = new Map(devices.map(device => [device.id, device]));

    let sentForTask = 0;
    let skippedForTask = 0;
    let failedForTask = 0;
    let retryable = false;
    let providerMessageId: string | undefined;

    for (const delivery of pending) {
      const device = deviceById.get(delivery.device_token_id);
      if (!device) {
        await deps.completeDelivery({ id: delivery.id, status: 'skipped', error: 'device_missing' });
        skippedForTask += 1;
        continue;
      }

      let outcome: SendOutcome;
      try {
        outcome = await deps.send(device, buildFcmMessage(task, device));
      } catch {
        outcome = { ok: false, status: 0, retryable: true, error: 'transport' };
      }

      if (outcome.ok) {
        sentForTask += 1;
        providerMessageId = providerMessageId || outcome.providerMessageId;
        await deps.completeDelivery({
          id: delivery.id,
          status: 'sent',
          providerMessageId: outcome.providerMessageId,
        });
        continue;
      }

      if (outcome.invalidToken) {
        skippedForTask += 1;
        await deps.completeDelivery({
          id: delivery.id,
          status: 'skipped',
          error: 'invalid_token',
          revokeToken: true,
        });
        continue;
      }

      failedForTask += 1;
      if (outcome.retryable) retryable = true;
      // الفشل المؤقت يبقى pending ليُعاد إرساله في المحاولة القادمة، بينما
      // الأجهزة التي نجحت (sent) لا تدخل في قائمة pending ولا تُعاد.
      await deps.completeDelivery({
        id: delivery.id,
        status: outcome.retryable ? 'pending' : 'failed',
        error: outcome.error || 'send_failed',
      });
    }

    summary.sent += sentForTask;
    summary.skipped += skippedForTask;
    summary.failed += failedForTask;

    // صف تسليم واحد على الأقل مضمون هنا: sent فقط عندما لا يوجد فشل،
    // والدليل هو صف تسليم منتهٍ (sent أو skipped) لا مجرد غياب الفشل.
    const hasRetry = retryable && failedForTask > 0;
    const allDone = failedForTask === 0;
    await deps.completeOutbox({
      id: task.id,
      status: allDone ? 'sent' : 'failed',
      worker: workerName,
      error: allDone ? undefined : (hasRetry ? 'transient' : 'permanent'),
      providerMessageId,
      retryDelaySeconds: hasRetry ? backoffSeconds(attempts) : 0,
    });
    summary.completed += 1;

    // سجل بلا رموز ولا محتوى: معرّفات وأرقام فقط.
    deps.log({
      event: 'outbox_task',
      task_id: task.id,
      event_type: safeText(task.event_type),
      devices: deliveries.length,
      pending: pending.length,
      sent: sentForTask,
      skipped: skippedForTask,
      failed: failedForTask,
      rescheduled: 0,
      reason: null,
    });
  }

  return summary;
}

export function constantTimeEquals(left: string, right: string): boolean {
  if (!left || !right || left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return difference === 0;
}

export type PushOutboxHandlerOptions = {
  secret: string;
  worker: string;
  limit?: number;
};

const jsonResponse = (body: Record<string, unknown>, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });

/** معالج HTTP: POST + سرّ العامل، ثم دفعة واحدة. لا كشف للأسرار. */
export function createPushOutboxHandler(
  deps: PushOutboxDeps,
  options: PushOutboxHandlerOptions,
): (request: Request) => Promise<Response> {
  return async (request: Request): Promise<Response> => {
    if (request.method !== 'POST') return jsonResponse({ ok: false, error: 'method_not_allowed' }, 405);
    if (!options.secret) return jsonResponse({ ok: false, error: 'worker_secret_missing' }, 503);

    const provided = request.headers.get('x-push-worker-secret') || '';
    if (!constantTimeEquals(provided, options.secret)) {
      return jsonResponse({ ok: false, error: 'unauthorized' }, 401);
    }

    try {
      const summary = await runPushOutboxBatch(deps, options.worker, options.limit ?? 10);
      return jsonResponse({ ok: true, ...summary });
    } catch {
      return jsonResponse({ ok: false, error: 'worker_failed' }, 500);
    }
  };
}
