// بناء محتوى إشعار FCM من سجل إشعار قاعدة البيانات.
// منطق مطابق لدالة Edge `send-push-notification` حتى يتطابق التوجيه عند الضغط.

export type NotificationRecord = Record<string, unknown>;

const asText = (value: unknown): string => (typeof value === "string" ? value.trim() : "");

const truncateUtf8 = (value: string, maxBytes: number): string => {
  let result = "";
  let byteLength = 0;
  for (const character of value) {
    const characterLength = Buffer.byteLength(character, "utf8");
    if (byteLength + characterLength > maxBytes) return `${result}…`;
    result += character;
    byteLength += characterLength;
  }
  return result;
};

export function notificationTitle(type: string): string {
  if (type === "like") return "إعجاب جديد";
  if (type === "comment" || type === "reply") return "تعليق جديد";
  if (["follow", "followed", "new_follower"].includes(type)) return "متابع جديد";
  if (type === "follow_request") return "طلب متابعة جديد";
  if (type === "message" || type === "new_message") return "رسالة جديدة";
  if (type === "call" || type === "incoming_call") return "مكالمة واردة";
  if (type.startsWith("story")) return "إشعار قصة جديد";
  return "إشعار جديد من آني";
}

export function preferenceCategory(type: string): string {
  if (["message", "new_message", "call", "incoming_call"].includes(type)) return "messages";
  if (["follow", "followed", "new_follower", "follow_request"].includes(type)) return "followers";
  if (type.startsWith("story")) return "stories";
  return "interactions";
}

export function notificationUrl(record: NotificationRecord, postIdForComment = ""): string {
  const type = asText(record.type).toLowerCase();
  const actorId = asText(record.actor_id);
  const referenceId = asText(record.reference_id) || asText(record.entity_id);
  const commentId = asText(record.comment_id);
  const postId = asText(record.post_id) || postIdForComment || referenceId;
  const encode = encodeURIComponent;

  const isStoryNotification =
    ["story", "story_like"].includes(type) ||
    (["like", "reply", "mention"].includes(type) && /ستوري|قصة/i.test(asText(record.content)));
  if (isStoryNotification && referenceId) {
    const storyOwnerId =
      ["story", "mention"].includes(type) ? actorId || asText(record.user_id) : asText(record.user_id);
    const query = new URLSearchParams({ openStoryId: referenceId, openStoryOwner: storyOwnerId });
    return `/feed?${query.toString()}`;
  }

  if (type === "follow_request") return "/feed?openFollowRequests=1";
  if (["follow", "followed", "new_follower"].includes(type) && actorId) return `/profile/${encode(actorId)}`;
  if (["message", "new_message"].includes(type) && actorId) return `/messages/${encode(actorId)}`;
  if (["call", "incoming_call"].includes(type) && actorId) {
    const query = new URLSearchParams({ openCall: "1", callerId: actorId });
    if (referenceId) query.set("callId", referenceId);
    return `/messages/${encode(actorId)}?${query.toString()}`;
  }
  if (["comment", "reply"].includes(type) && postId) {
    const query = new URLSearchParams({ showComments: "1" });
    if (commentId) query.set("commentId", commentId);
    return `/post/${encode(postId)}?${query.toString()}`;
  }
  if (["like", "repost"].includes(type) && postId) return `/post/${encode(postId)}`;
  return "/feed";
}

export type NotificationContent = {
  title: string;
  body: string;
  url: string;
  type: string;
};

export function buildNotificationContent(
  record: NotificationRecord,
  postIdForComment = "",
): NotificationContent {
  const type = asText(record.type).toLowerCase();
  const title = asText(record.title) || notificationTitle(type);
  const body = asText(record.body) || asText(record.content) || title;
  return {
    title,
    body: truncateUtf8(body, 1500),
    url: asText(record.url) || notificationUrl(record, postIdForComment),
    type,
  };
}
