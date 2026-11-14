import { supabase } from '@/lib/supabase';

/**
 * إرسال رد ستوري كرسالة خاصة واحدة، مع علامة صريحة تُميّزه عن:
 *   * مشاركة الستوري العادية داخل DM (content يبدأ بـ[story:...] + story_id).
 *   * الرسالة العادية.
 *
 * العلامة هي العمود messages.story_reply = true (20270131000000)، ويُستخدم
 * الوسم القديم [story-reply] كبديل فقط على قاعدة لم يُطبَّق عليها العمود بعد.
 * بهذا لا يتحول أي رد جديد إلى نص عادي يُعامل كرسالة عادية فيُنشئ إشعاراً.
 */
export const LEGACY_STORY_REPLY_PREFIX = '[story-reply]';

export const STORY_SHARE_CONTENT_PREFIX = '[story:';

export interface StoryReplyInsertInput {
  senderId: string;
  recipientId: string;
  /** نص الرد وحده، بلا أي وسم. */
  text: string;
  storyId: string | null;
  storyMediaUrl: string | null;
  storyThumbnailUrl: string | null;
  storyMediaType: string | null;
}

export interface StoryReplyInsertError {
  message?: string;
  code?: string;
  details?: string;
  hint?: string;
}

export interface StoryReplyInsertResult {
  error: StoryReplyInsertError | null;
}

export interface StoryReplyMessageLike {
  content: string;
  post_id?: string | null;
  story_id?: string | null;
  story_reply?: boolean | null;
  story_media_url?: string | null;
  story_thumbnail_url?: string | null;
  story_media_type?: string | null;
}

type MessageInsertPayload = Record<string, unknown>;

function toStoryReplyInsertError(error: unknown): StoryReplyInsertError {
  if (error && typeof error === 'object') {
    const record = error as Record<string, unknown>;
    return {
      message: typeof record.message === 'string' ? record.message : undefined,
      code: typeof record.code === 'string' ? record.code : undefined,
      details: typeof record.details === 'string' ? record.details : undefined,
      hint: typeof record.hint === 'string' ? record.hint : undefined,
    };
  }
  return { message: typeof error === 'string' ? error : undefined };
}

function insertErrorText(error: StoryReplyInsertError | null): string {
  if (!error) return '';
  return [error.message, error.details, error.hint].filter(Boolean).join(' ');
}

export function hasLegacyStoryReplyPrefix(content: string): boolean {
  return content.trimStart().startsWith(LEGACY_STORY_REPLY_PREFIX);
}

export function hasStoredStoryReplyMedia(message: StoryReplyMessageLike): boolean {
  return Boolean(message.story_media_url || message.story_thumbnail_url || message.story_media_type);
}

/**
 * هل هذه الرسالة رد ستوري؟
 * العلامة الصريحة (story_reply) أو الوسم القديم. حقول المعاينة وحدها ليست كافية
 * لأن مشاركة الستوري تحمل story_id أيضاً؛ نستخدمها فقط كتوافق عرض للصفوف التي
 * كُتبت قبل إضافة العمود، ولا تُستخدم في أي قرار على مستوى قاعدة البيانات.
 */
export function isStoryReplyMessage(message: StoryReplyMessageLike): boolean {
  if (message.post_id) return false;
  const content = message.content.trim();
  if (hasLegacyStoryReplyPrefix(content)) return true;
  if (message.story_reply === true) return true;
  if (content.startsWith(STORY_SHARE_CONTENT_PREFIX)) return false;
  return hasStoredStoryReplyMedia(message);
}

/** نص الرد وحده، دون الوسم القديم. */
export function storyReplyText(message: StoryReplyMessageLike): string {
  const content = message.content.trim();
  return hasLegacyStoryReplyPrefix(content)
    ? content.slice(LEGACY_STORY_REPLY_PREFIX.length).trim()
    : content;
}

async function insertStoryReplyPayload(payload: MessageInsertPayload): Promise<StoryReplyInsertResult> {
  const { error } = await supabase.from('messages').insert(payload);
  return { error: toStoryReplyInsertError(error) };
}

export async function sendStoryReplyMessage(input: StoryReplyInsertInput): Promise<StoryReplyInsertResult> {
  const basePayload: MessageInsertPayload = {
    sender_id: input.senderId,
    recipient_id: input.recipientId,
    content: input.text,
    story_reply: true,
  };
  if (input.storyId) basePayload.story_id = input.storyId;
  if (input.storyMediaUrl) basePayload.story_media_url = input.storyMediaUrl;
  if (input.storyThumbnailUrl) basePayload.story_thumbnail_url = input.storyThumbnailUrl;
  if (input.storyMediaType) basePayload.story_media_type = input.storyMediaType;

  let payload: MessageInsertPayload = { ...basePayload };
  let result = await insertStoryReplyPayload(payload);

  // قاعدة لم تُطبَّق عليها أعمدة معاينة الستوري بعد: نُبقي العلامة story_reply.
  if (result.error && /story_media_url|story_thumbnail_url|story_media_type/i.test(insertErrorText(result.error))) {
    delete payload.story_media_url;
    delete payload.story_thumbnail_url;
    delete payload.story_media_type;
    result = await insertStoryReplyPayload(payload);
  }

  // قاعدة بلا messages.story_id: العلامة تبقى، والبطاقة تعتمد على وسائط محفوظة.
  if (result.error && /story_id/i.test(insertErrorText(result.error))) {
    delete payload.story_id;
    result = await insertStoryReplyPayload(payload);
  }

  // قاعدة بلا عمود story_reply: البديل الوحيد الآمن هو الوسم القديم، مموّه في
  // الواجهة، وليس نصاً عادياً يُعامل كرسالة عادية.
  if (result.error && /story_reply/i.test(insertErrorText(result.error))) {
    result = await insertStoryReplyPayload({
      sender_id: input.senderId,
      recipient_id: input.recipientId,
      content: `${LEGACY_STORY_REPLY_PREFIX}${input.text}`,
    });
  }

  return result;
}
