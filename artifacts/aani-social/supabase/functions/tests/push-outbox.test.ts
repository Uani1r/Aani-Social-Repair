// اختبارات Deno لعامل إرسال notification_outbox إلى أجهزة FCM.
//
// تُشغَّل بـ: deno test --allow-read tests/push-outbox.test.ts
// بلا شبكة ولا مشروع Supabase ولا Firebase: كل قراءة وكتابة وإرسال تمر عبر
// قوالب وهمية، ونتحقق من: الإرسال إلى كل جهاز نشط، حجز مهمة واحدة لعامل
// واحد، إعادة المحاولة للفشل المؤقت وحده، إلغاء الرمز غير الصالح، عدم إعادة
// الإرسال إلى جهاز نجح، حمولة بلا نص رسالة، وسجل بلا رموز.

import {
  backoffSeconds,
  buildFcmMessage,
  classifyFcmResult,
  createPushOutboxHandler,
  notificationDestination,
  runPushOutboxBatch,
  type DeliveryCompletion,
  type DeliveryRow,
  type DeviceTokenRow,
  type LogEntry,
  type OutboxCompletion,
  type OutboxTask,
  type PushOutboxDeps,
  type SendOutcome,
} from "../_shared/pushOutbox.ts";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function assertEqual(actual: unknown, expected: unknown, message: string): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${message}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

const RECIPIENT = "b0000000-0000-0000-0000-00000000000b";

type FakeTask = {
  id: string;
  recipient_user_id: string;
  event_type: string;
  payload: Record<string, unknown>;
  attempts: number;
  status: "pending" | "claimed" | "sent" | "failed";
  availableAt: number;
};

type FakeDelivery = DeliveryRow & {
  attempts: number;
  lastError: string | null;
  providerMessageId: string | null;
  sentAt: number | null;
};

type FakeDevice = DeviceTokenRow & { revoked: boolean };

type FakeState = {
  now: number;
  tasks: FakeTask[];
  deliveries: FakeDelivery[];
  devices: FakeDevice[];
  sendCalls: Array<{ deviceId: string; message: Record<string, unknown> }>;
  deliveryCompletions: DeliveryCompletion[];
  outboxCompletions: OutboxCompletion[];
  logs: LogEntry[];
};

type FakeHarness = {
  state: FakeState;
  deps: PushOutboxDeps;
  enqueue: (id: string, eventType: string, payload?: Record<string, unknown>) => void;
  advanceSeconds: (seconds: number) => void;
};

function createFake(options: {
  devices: Array<{ id: string; token: string; platform?: string }>;
  send: (device: DeviceTokenRow) => SendOutcome;
}): FakeHarness {
  const state: FakeState = {
    now: 1_700_000_000_000,
    tasks: [],
    deliveries: [],
    devices: options.devices.map(device => ({
      id: device.id,
      token: device.token,
      platform: device.platform || "web",
      provider: "fcm",
      revoked: false,
    })),
    sendCalls: [],
    deliveryCompletions: [],
    outboxCompletions: [],
    logs: [],
  };

  const pendingOf = (outboxId: string): FakeDelivery[] =>
    state.deliveries.filter(item => item.outbox_id === outboxId);

  const deps: PushOutboxDeps = {
    async claim(worker, limit): Promise<OutboxTask[]> {
      const claimable = state.tasks
        .filter(task => task.status === "pending" && task.availableAt <= state.now)
        .slice(0, Math.max(0, limit));
      for (const task of claimable) {
        task.status = "claimed";
        task.attempts += 1;
      }
      return claimable.map(task => ({
        id: task.id,
        recipient_user_id: task.recipient_user_id,
        event_type: task.event_type,
        payload: task.payload,
        attempts: task.attempts,
      }));
    },
    async ensureDeliveries(outboxId): Promise<DeliveryRow[]> {
      for (const device of state.devices) {
        if (device.revoked) continue;
        const existing = state.deliveries.find(
          item => item.outbox_id === outboxId && item.device_token_id === device.id,
        );
        if (existing) continue;
        state.deliveries.push({
          id: `delivery-${outboxId}-${device.id}`,
          outbox_id: outboxId,
          device_token_id: device.id,
          status: "pending",
          attempts: 0,
          lastError: null,
          providerMessageId: null,
          sentAt: null,
        });
      }
      return pendingOf(outboxId);
    },
    async listPendingDeliveries(outboxId): Promise<DeliveryRow[]> {
      return pendingOf(outboxId)
        .filter(item => item.status === "pending")
        .map(item => ({
          id: item.id,
          outbox_id: item.outbox_id,
          device_token_id: item.device_token_id,
          status: item.status,
        }));
    },
    async loadDevices(deviceIds): Promise<DeviceTokenRow[]> {
      return state.devices
        .filter(device => !device.revoked && deviceIds.includes(device.id))
        .map(device => ({
          id: device.id,
          token: device.token,
          platform: device.platform,
          provider: device.provider,
        }));
    },
    async send(device, message): Promise<SendOutcome> {
      state.sendCalls.push({ deviceId: device.id, message });
      return options.send(device);
    },
    async completeDelivery(completion): Promise<void> {
      state.deliveryCompletions.push(completion);
      const delivery = state.deliveries.find(item => item.id === completion.id);
      if (!delivery) return;
      delivery.status = completion.status;
      delivery.attempts += 1;
      delivery.lastError = completion.status === "sent" ? null : completion.error || null;
      delivery.providerMessageId = completion.providerMessageId || delivery.providerMessageId;
      delivery.sentAt = completion.status === "sent" ? state.now : null;
      if (completion.revokeToken) {
        const device = state.devices.find(item => item.id === delivery.device_token_id);
        if (device) device.revoked = true;
      }
    },
    async completeOutbox(completion): Promise<void> {
      state.outboxCompletions.push(completion);
      const task = state.tasks.find(item => item.id === completion.id);
      if (!task) return;
      if (completion.status === "sent") {
        task.status = "sent";
        return;
      }
      if ((completion.retryDelaySeconds || 0) > 0) {
        task.status = "pending";
        task.availableAt = state.now + (completion.retryDelaySeconds || 0) * 1000;
        return;
      }
      task.status = "failed";
    },
    log(entry): void {
      state.logs.push(entry);
    },
  };

  return {
    state,
    deps,
    enqueue(id, eventType, payload) {
      state.tasks.push({
        id,
        recipient_user_id: RECIPIENT,
        event_type: eventType,
        payload: payload || {},
        attempts: 0,
        status: "pending",
        availableAt: state.now,
      });
    },
    advanceSeconds(seconds) {
      state.now += seconds * 1000;
    },
  };
}

const delivered = (device: DeviceTokenRow): SendOutcome => ({
  ok: true,
  status: 200,
  providerMessageId: `projects/aani-social/messages/${device.id}`,
});

const MESSAGE_TOKEN = "fcm-token-web-very-secret";
const MESSAGE_BODY = "نص رسالة خاص جداً";

Deno.test("an event reaches every active device of the recipient", async () => {
  const fake = createFake({
    devices: [{ id: "device-web", token: MESSAGE_TOKEN }, { id: "device-android", token: "fcm-token-android" }],
    send: delivered,
  });
  fake.enqueue("outbox-1", "message", { message_id: "message-1", sender_id: "user-a", content: MESSAGE_BODY });

  const summary = await runPushOutboxBatch(fake.deps, "worker-1", 10);

  assertEqual(summary, { claimed: 1, sent: 2, skipped: 0, failed: 0, completed: 1 }, "both devices must be sent to");
  assertEqual(
    fake.state.sendCalls.map(call => call.deviceId),
    ["device-web", "device-android"],
    "each active device must get the event once",
  );
  assertEqual(
    fake.state.deliveries.map(item => item.status),
    ["sent", "sent"],
    "both deliveries must end as sent",
  );
  assertEqual(fake.state.outboxCompletions.length, 1, "the task must be completed once");
  assertEqual(fake.state.outboxCompletions[0].status, "sent", "a task whose devices all succeeded is sent");
  assert(!fake.state.outboxCompletions[0].retryDelaySeconds, "a sent task needs no retry delay");
});

Deno.test("a second worker claims nothing once the first claimed the task", async () => {
  const fake = createFake({ devices: [{ id: "device-web", token: MESSAGE_TOKEN }], send: delivered });
  fake.enqueue("outbox-1", "notification", { notification_id: "notification-1", type: "like" });

  const first = await runPushOutboxBatch(fake.deps, "worker-1", 10);
  const second = await runPushOutboxBatch(fake.deps, "worker-2", 10);

  assertEqual(first.claimed, 1, "the first worker claims the task");
  assertEqual(second.claimed, 0, "the second worker must claim nothing");
  assertEqual(fake.state.sendCalls.length, 1, "the event is sent once, not twice");
});

Deno.test("a transient failure keeps only that device retryable", async () => {
  let androidOutcome: SendOutcome = { ok: false, status: 503, retryable: true, error: "transient" };
  const fake = createFake({
    devices: [
      { id: "device-web", token: MESSAGE_TOKEN },
      { id: "device-android", token: "fcm-token-android", platform: "android" },
    ],
    send: device => (device.platform === "android" ? androidOutcome : delivered(device)),
  });
  fake.enqueue("outbox-1", "message", { message_id: "message-1", sender_id: "user-a" });

  const first = await runPushOutboxBatch(fake.deps, "worker-1", 10);

  assertEqual(first.sent, 1, "the reachable device must be sent to");
  assertEqual(first.failed, 1, "the unreachable device must be counted as failed");
  const android = fake.state.deliveries.find(item => item.device_token_id === "device-android");
  assert(android !== undefined, "the android device has a delivery");
  assertEqual(android.status, "pending", "a transient failure stays pending");
  assertEqual(android.lastError, "transient", "the retry keeps a short reason code");
  assertEqual(
    fake.state.outboxCompletions[0].status,
    "failed",
    "a task with a failed device is not complete",
  );
  assertEqual(
    fake.state.outboxCompletions[0].retryDelaySeconds,
    backoffSeconds(1),
    "the retry is delayed by the backoff",
  );

  // المحاولة القادمة بعد التأخير.
  androidOutcome = { ok: true, status: 200, providerMessageId: "projects/aani-social/messages/2" };
  fake.advanceSeconds(backoffSeconds(1));
  const retry = await runPushOutboxBatch(fake.deps, "worker-2", 10);

  assertEqual(retry.claimed, 1, "the delayed task is claimable again");
  assertEqual(retry.sent, 1, "the retry sends to the device that failed only");
  assertEqual(
    fake.state.sendCalls.map(call => call.deviceId),
    ["device-web", "device-android", "device-android"],
    "a device that already succeeded is never sent to again",
  );
  assertEqual(fake.state.outboxCompletions[1].status, "sent", "the task completes once every device succeeded");
});

Deno.test("an invalid token is revoked, skipped and never retried", async () => {
  const fake = createFake({
    devices: [{ id: "device-web", token: MESSAGE_TOKEN }],
    send: () => ({ ok: false, status: 404, invalidToken: true, error: "unregistered" }),
  });
  fake.enqueue("outbox-1", "notification", { notification_id: "notification-1", type: "follow" });

  const summary = await runPushOutboxBatch(fake.deps, "worker-1", 10);

  assertEqual(summary.skipped, 1, "an invalid token is skipped");
  assertEqual(summary.failed, 0, "an invalid token is not a failure");
  assertEqual(fake.state.deliveryCompletions[0].status, "skipped", "the delivery ends as skipped");
  assertEqual(fake.state.deliveryCompletions[0].revokeToken, true, "the device token is revoked");
  const device = fake.state.devices[0];
  assert(device.revoked, "the device token must be marked revoked");
  assertEqual(fake.state.outboxCompletions[0].status, "sent", "a task with no failures is complete");

  fake.advanceSeconds(3600);
  const later = await runPushOutboxBatch(fake.deps, "worker-2", 10);
  assertEqual(later.claimed, 0, "a finished task is not claimed again");
  assertEqual(fake.state.sendCalls.length, 1, "an invalid token is not retried");
});

Deno.test("a permanent rejection fails the delivery without a retry", async () => {
  const fake = createFake({
    devices: [{ id: "device-web", token: MESSAGE_TOKEN }],
    send: () => ({ ok: false, status: 403, error: "rejected" }),
  });
  fake.enqueue("outbox-1", "call", { call_id: "call-1", message_id: "message-1", mode: "audio" });

  const summary = await runPushOutboxBatch(fake.deps, "worker-1", 10);

  assertEqual(summary.failed, 1, "a rejected send is a failure");
  assertEqual(fake.state.deliveryCompletions[0].status, "failed", "a permanent failure ends the delivery");
  assertEqual(fake.state.outboxCompletions[0].status, "failed", "the task is marked failed");
  assertEqual(
    fake.state.outboxCompletions[0].retryDelaySeconds,
    0,
    "a permanent failure schedules no retry",
  );
  assertEqual(fake.state.outboxCompletions[0].error, "permanent", "a permanent failure is recorded as such");

  fake.advanceSeconds(3600);
  const later = await runPushOutboxBatch(fake.deps, "worker-2", 10);
  assertEqual(later.claimed, 0, "a permanently failed task is not claimed again");
  assertEqual(fake.state.sendCalls.length, 1, "a permanent failure is not retried");
});

Deno.test("a recipient without an active device completes without sending", async () => {
  const fake = createFake({ devices: [], send: delivered });
  fake.enqueue("outbox-1", "message", { message_id: "message-1", sender_id: "user-a" });

  const summary = await runPushOutboxBatch(fake.deps, "worker-1", 10);

  assertEqual(summary.sent, 0, "there is no device to send to");
  assertEqual(fake.state.sendCalls.length, 0, "nothing is sent without a device");
  assertEqual(fake.state.outboxCompletions[0].status, "sent", "the task completes with nothing to deliver");
});

Deno.test("classifies FCM responses as success, invalid token, retryable or rejected", () => {
  const ok = classifyFcmResult(200, '{"name":"projects/aani-social/messages/9"}');
  assert(ok.ok, "a 200 response is a success");
  assertEqual(ok.providerMessageId, "projects/aani-social/messages/9", "the message name is kept");

  assert(classifyFcmResult(404, '{"error":{"status":"NOT_FOUND"}}').invalidToken === true, "404 is an invalid token");
  assert(
    classifyFcmResult(400, '{"error":{"details":[{"errorCode":"INVALID_ARGUMENT"}]}}').invalidToken === true,
    "an invalid argument for a registration token is an invalid token",
  );
  assert(classifyFcmResult(429, '{"error":{"status":"RESOURCE_EXHAUSTED"}}').retryable === true, "429 is retryable");
  assert(classifyFcmResult(503, "").retryable === true, "5xx is retryable");
  assert(classifyFcmResult(408, "").retryable === true, "a timeout is retryable");

  const rejected = classifyFcmResult(403, '{"error":{"status":"PERMISSION_DENIED"}}');
  assert(!rejected.ok && !rejected.retryable && !rejected.invalidToken, "403 is a permanent rejection");
  assert(rejected.error === "rejected", "a permanent rejection keeps a reason code only");
  assert(!JSON.stringify(rejected).includes("PERMISSION_DENIED"), "the provider body is never passed on");
});

Deno.test("the push payload carries ids and types only", () => {
  const message = buildFcmMessage(
    {
      id: "outbox-1",
      recipient_user_id: RECIPIENT,
      event_type: "message",
      payload: { message_id: "message-1", sender_id: "user-a", content: MESSAGE_BODY },
    },
    { id: "device-web", token: MESSAGE_TOKEN, platform: "web", provider: "fcm" },
  );

  const serialised = JSON.stringify(message);
  assert(!serialised.includes(MESSAGE_BODY), "a message body must never travel in a push");
  assert(!serialised.includes("content"), "the payload has no content field");
  const data = message.data as Record<string, string>;
  assertEqual(data.type, "message", "a message push is typed as a message");
  assertEqual(data.message_id, "message-1", "the message id travels for the app to open it");
  assertEqual(data.sender_id, "user-a", "the sender id travels");
  assertEqual((message.notification as Record<string, string>).title, "رسالة جديدة", "the title is generic");

  const call = buildFcmMessage(
    {
      id: "outbox-2",
      recipient_user_id: RECIPIENT,
      event_type: "call",
      payload: { call_id: "call-1", message_id: "message-2", mode: "audio", content: MESSAGE_BODY },
    },
    { id: "device-web", token: MESSAGE_TOKEN, platform: "web", provider: "fcm" },
  );
  assert(!JSON.stringify(call).includes(MESSAGE_BODY), "a call push carries no content");
  const callData = call.data as Record<string, string>;
  assertEqual(callData.call_id, "call-1", "the call id travels");
  assertEqual((call.notification as Record<string, string>).title, "مكالمة واردة", "the call title is fixed");

  const like = buildFcmMessage(
    {
      id: "outbox-3",
      recipient_user_id: RECIPIENT,
      event_type: "notification",
      payload: { type: "like", notification_id: "notification-1", reference_id: "post-1" },
    },
    { id: "device-web", token: MESSAGE_TOKEN, platform: "web", provider: "fcm" },
  );
  const likeData = like.data as Record<string, string>;
  assertEqual(likeData.type, "like", "a social push carries its type");
  assertEqual(likeData.notification_id, "notification-1", "the notification id travels");
  assertEqual(likeData.reference_id, "post-1", "the reference id travels");
  assertEqual((like.notification as Record<string, string>).title, "إعجاب جديد", "a like has its own title");
});

Deno.test("the backoff grows and stays within an hour", () => {
  assertEqual(backoffSeconds(1), 60, "the first retry waits a minute");
  assertEqual(backoffSeconds(2), 120, "the second retry doubles");
  assertEqual(backoffSeconds(3), 240, "the third retry doubles again");
  assertEqual(backoffSeconds(20), 3600, "the backoff is capped at an hour");
  assertEqual(backoffSeconds(0), 60, "an unknown attempt count starts at a minute");
});

Deno.test("the worker refuses anything but a signed POST", async () => {
  const fake = createFake({ devices: [{ id: "device-web", token: MESSAGE_TOKEN }], send: delivered });
  fake.enqueue("outbox-1", "notification", { notification_id: "notification-1", type: "like" });
  const handler = createPushOutboxHandler(fake.deps, { secret: "worker-secret", worker: "worker-1", limit: 10 });

  const wrongMethod = await handler(new Request("https://example.test/push-outbox", { method: "GET" }));
  assertEqual(wrongMethod.status, 405, "a GET must be refused");

  const noSecret = await handler(new Request("https://example.test/push-outbox", { method: "POST" }));
  assertEqual(noSecret.status, 401, "a request without the worker secret is refused");

  const wrongSecret = await handler(
    new Request("https://example.test/push-outbox", {
      method: "POST",
      headers: { "x-push-worker-secret": "not-the-secret" },
    }),
  );
  assertEqual(wrongSecret.status, 401, "a wrong worker secret is refused");
  assertEqual(fake.state.sendCalls.length, 0, "no device is written to without the secret");

  const missingSecret = createPushOutboxHandler(fake.deps, { secret: "", worker: "worker-1", limit: 10 });
  const unconfigured = await missingSecret(new Request("https://example.test/push-outbox", { method: "POST" }));
  assertEqual(unconfigured.status, 503, "an unconfigured worker secret fails closed");

  const ok = await handler(
    new Request("https://example.test/push-outbox", {
      method: "POST",
      headers: { "x-push-worker-secret": "worker-secret" },
    }),
  );
  assertEqual(ok.status, 200, "the signed POST runs one batch");
  const body = await ok.json() as Record<string, unknown>;
  assertEqual(body.sent, 1, "the body reports what was sent");
  assertEqual(body.ok, true, "the body reports success");
  assert(!JSON.stringify(body).includes(MESSAGE_TOKEN), "the response never carries a device token");
  assert(!JSON.stringify(fake.state.logs).includes(MESSAGE_TOKEN), "no log entry carries a device token");
  assert(!JSON.stringify(fake.state.logs).includes("not-the-secret"), "no log entry carries the worker secret");
  assert(fake.state.logs.length === 1, "one summary entry per task");
  assertEqual(
    Object.keys(fake.state.logs[0]).sort(),
    ["devices", "event", "event_type", "failed", "sent", "skipped", "task_id"].sort(),
    "a log entry keeps ids and counts only",
  );
});


const WEB_DEVICE: DeviceTokenRow = {
  id: "device-web",
  token: MESSAGE_TOKEN,
  platform: "web",
  provider: "fcm",
};

function outboxTask(eventType: string, payload: Record<string, unknown>): OutboxTask {
  return { id: "outbox-1", recipient_user_id: RECIPIENT, event_type: eventType, payload };
}

Deno.test("كل إشعار يفتح مساراً فعلياً من مسارات التطبيق", () => {
  const urls = {
    message: notificationDestination(outboxTask("message", { message_id: "message-1", sender_id: "sender-1" })),
    call: notificationDestination(outboxTask("call", { call_id: "call-1", sender_id: "sender-1" })),
    callWithoutId: notificationDestination(outboxTask("call", { sender_id: "sender-1" })),
    messageWithoutSender: notificationDestination(outboxTask("message", { message_id: "message-1" })),
    follow: notificationDestination(outboxTask("notification", { type: "follow", actor_id: "actor-1" })),
    followRequest: notificationDestination(outboxTask("notification", { type: "follow_request" })),
    comment: notificationDestination(outboxTask("notification", { type: "comment", reference_id: "post-1" })),
    reply: notificationDestination(outboxTask("notification", { type: "reply", reference_id: "post-1" })),
    like: notificationDestination(outboxTask("notification", { type: "like", reference_id: "post-1" })),
    repost: notificationDestination(outboxTask("notification", { type: "repost", reference_id: "post-1" })),
    storyLike: notificationDestination(outboxTask("notification", { type: "story_like", reference_id: "story-1" })),
    storyMention: notificationDestination(outboxTask("notification", {
      type: "story_mention",
      reference_id: "story-1",
      actor_id: "actor-1",
    })),
    unknown: notificationDestination(outboxTask("notification", { type: "system" })),
    commentWithoutPost: notificationDestination(outboxTask("notification", { type: "comment" })),
  };

  assertEqual(urls.message, "/messages/sender-1", "a message opens its conversation");
  assertEqual(
    urls.call,
    "/messages/sender-1?openCall=1&callerId=sender-1&callId=call-1",
    "a call opens the conversation with the incoming-call query",
  );
  assertEqual(
    urls.callWithoutId,
    "/messages/sender-1?openCall=1&callerId=sender-1",
    "a call without an id still opens the conversation",
  );
  assertEqual(urls.messageWithoutSender, "/feed", "a message without a sender falls back to the feed");
  assertEqual(urls.follow, "/profile/actor-1", "a follow opens the actor profile");
  assertEqual(urls.followRequest, "/feed?openFollowRequests=1", "a follow request opens the request list");
  assertEqual(urls.comment, "/post/post-1?showComments=1", "a comment opens the post comments");
  assertEqual(urls.reply, "/post/post-1?showComments=1", "a reply opens the post comments");
  assertEqual(urls.like, "/post/post-1", "a like opens its post");
  assertEqual(urls.repost, "/post/post-1", "a repost opens its post");
  assertEqual(
    urls.storyLike,
    `/feed?openStoryId=story-1&openStoryOwner=${RECIPIENT}`,
    "a story like opens the recipient story",
  );
  assertEqual(
    urls.storyMention,
    "/feed?openStoryId=story-1&openStoryOwner=actor-1",
    "a story mention opens the actor story",
  );
  assertEqual(urls.unknown, "/feed", "an unknown type falls back to the feed");
  assertEqual(urls.commentWithoutPost, "/feed", "a comment without a post falls back to the feed");
});

Deno.test("حمولة FCM تحمل حقول العرض التي يقرأها عامل الخدمة", () => {
  const tasks = [
    outboxTask("message", { message_id: "message-1", sender_id: "sender-1" }),
    outboxTask("call", { call_id: "call-1", sender_id: "sender-1", mode: "audio" }),
    outboxTask("notification", { type: "like", notification_id: "notification-1", reference_id: "post-1" }),
  ];

  for (const task of tasks) {
    const message = buildFcmMessage(task, WEB_DEVICE);
    const data = message.data as Record<string, string>;
    const shown = message.notification as Record<string, string>;

    assert(data.title.length > 0, "data.title must be present");
    assert(data.body.length > 0, "data.body must be present");
    assertEqual(data.url, notificationDestination(task), "data.url is the app destination");
    assert(data.url.startsWith("/"), "a destination is an in-app path");
    assertEqual(data.title, shown.title, "data.title matches the notification title");
    assertEqual(data.body, shown.body, "data.body matches the notification body");
  }
});

Deno.test("عامل الخدمة يقرأ نفس حقول العرض ويرفض العناوين الخارجية", async () => {
  const serviceWorker = await Deno.readTextFile(
    new URL("../../../public/firebase-messaging-sw.js", import.meta.url),
  );

  const titleLine = /const title = [^\n]+/.exec(serviceWorker)?.[0] || "";
  const bodyLine = /const body = [^\n]+/.exec(serviceWorker)?.[0] || "";
  const targetLine = /const target = [^\n]+/.exec(serviceWorker)?.[0] || "";

  assert(serviceWorker.includes("payload.data"), "the handler reads payload.data");
  assert(serviceWorker.includes("payload.notification"), "the handler reads payload.notification as a fallback");
  assert(
    titleLine.includes("data.title") && titleLine.includes("fallback.title"),
    "the title comes from data first and notification second",
  );
  assert(
    bodyLine.includes("data.body") && bodyLine.includes("fallback.body"),
    "the body comes from data first and notification second",
  );
  assert(targetLine.includes("data.url"), "the click target comes from data.url");

  // كل حقل عرض يبنيه العامل يقرأه عامل الخدمة.
  for (const key of ["title", "body", "url", "notification_id"]) {
    assert(serviceWorker.includes(`data.${key}`), `the service worker must read data.${key}`);
  }

  // منع الروابط الخارجية بقي كما هو.
  assert(
    serviceWorker.includes("target.origin === self.location.origin"),
    "only same-origin targets are accepted",
  );
  assert(/new URL\('\/feed', self\.location\.origin\)/.test(serviceWorker), "an external target falls back to /feed");
});

Deno.test("لا نص رسالة ولا محتوى مكالمة في الحمولة أو الوجهة", () => {
  const secret = "نص رسالة خاص جداً";
  const message = buildFcmMessage(
    outboxTask("message", { message_id: "message-1", sender_id: "sender-1", content: secret }),
    WEB_DEVICE,
  );
  const call = buildFcmMessage(
    outboxTask("call", { call_id: "call-1", sender_id: "sender-1", mode: "audio", content: secret }),
    WEB_DEVICE,
  );

  for (const payload of [message, call]) {
    const serialised = JSON.stringify(payload);
    assert(!serialised.includes(secret), "no message content may travel in a push");
    assert(!serialised.includes("content"), "a push carries no content field");
    const data = payload.data as Record<string, string>;
    assert(!data.url.includes(secret), "the destination carries no content");
    assertEqual((payload.notification as Record<string, string>).body.includes(secret), false, "the body is generic");
  }

  assertEqual((message.data as Record<string, string>).url, "/messages/sender-1", "a message push opens the chat");
  assert(
    (call.data as Record<string, string>).url.startsWith("/messages/sender-1?openCall=1"),
    "a call push opens the chat with the call query",
  );
});
