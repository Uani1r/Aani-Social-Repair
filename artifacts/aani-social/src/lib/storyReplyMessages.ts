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

type InsertFailureCategory = 'schema' | 'permission' | 'constraint' | 'auth' | 'unknown';

/** تصنيف عام للفشل يُستخدم في السجل بدل نص رسالة PostgREST. */
function classifyInsertFailure(error: StoryReplyInsertError): InsertFailureCategory {
  const code = error.code ?? '';
  if (code === '42703' || code === 'PGRST204') return 'schema';
  if (code === '42501') return 'permission';
  if (code === '23505' || code === '23503' || code === '23502' || code === '23514') return 'constraint';
  if (code === 'PGRST301' || code === '401' || code === '403') return 'auth';
  return 'unknown';
}

/**
 * الوسم القديم قد يظهر في بداية النص أو نهايته (مع مسافات قبله/بعده).
 * لا نعتمد على المظهر البصري ولا على اتجاه النص: المقارنة على حدود النص
 * المنطقية بعد trim، فتعمل مع RTL وLTR على السواء.
 */
export function hasLegacyStoryReplyTag(content: string): boolean {
  const trimmed = content.trim();
  if (!trimmed) return false;
  return trimmed.startsWith(LEGACY_STORY_REPLY_PREFIX)
    || trimmed.endsWith(LEGACY_STORY_REPLY_PREFIX);
}

/** @deprecated استخدم hasLegacyStoryReplyTag لأن الوسم قد يظهر في النهاية أيضاً. */
export function hasLegacyStoryReplyPrefix(content: string): boolean {
  return hasLegacyStoryReplyTag(content);
}

/**
 * يحذف الوسم من بداية النص و/أو نهايته فقط، مع تقليم المسافات الزائدة.
 * لا يُحذف أي جزء من نص المستخدم في وسط الرسالة.
 */
export function stripLegacyStoryReplyTag(content: string): string {
  let text = content.trim();
  if (text.startsWith(LEGACY_STORY_REPLY_PREFIX)) {
    text = text.slice(LEGACY_STORY_REPLY_PREFIX.length).trim();
  }
  if (text.endsWith(LEGACY_STORY_REPLY_PREFIX)) {
    text = text.slice(0, text.length - LEGACY_STORY_REPLY_PREFIX.length).trim();
  }
  return text;
}

export function hasStoredStoryReplyMedia(message: StoryReplyMessageLike): boolean {
  return Boolean(message.story_media_url || message.story_thumbnail_url || message.story_media_type);
}

/**
 * هل هذه الرسالة رد ستوري؟
 * الأولوية للعلامة الصريحة story_reply === true، ثم الوسم القديم في البداية أو
 * النهاية، ثم حقول المعاينة المحفوظة (توافق عرض لصفوف سابقة للعمود فقط).
 * مشاركة الستوري العادية [story:...] ليست رداً حتى لو حملت story_id.
 */
export function isStoryReplyMessage(message: StoryReplyMessageLike): boolean {
  if (message.post_id) return false;
  if (message.story_reply === true) return true;
  const content = message.content.trim();
  if (hasLegacyStoryReplyTag(content)) return true;
  if (content.startsWith(STORY_SHARE_CONTENT_PREFIX)) return false;
  return hasStoredStoryReplyMedia(message);
}

/** نص الرد وحده، دون الوسم القديم من أي طرف. */
export function storyReplyText(message: StoryReplyMessageLike): string {
  return hasLegacyStoryReplyTag(message.content)
    ? stripLegacyStoryReplyTag(message.content)
    : message.content.trim();
}

/** قاعدة البيانات تستخدم image وphoto معاً لوسائط الصور. */
export function isImageStoryMediaType(mediaType: string | null | undefined): boolean {
  return mediaType === 'image' || mediaType === 'photo';
}

export function isVideoStoryMediaType(mediaType: string | null | undefined): boolean {
  return mediaType === 'video';
}

/**
 * يعيد الرابط فقط إذا كان مطلقاً http(s) كما هو محفوظ في قاعدة البيانات.
 * لا يُعاد تكوين أي رابط ImageKit من مسار تخزين محلي أو من سجل الذاكرة المؤقت،
 * لأن ذلك قد ينتج رابطاً غير صالح أو مختلفاً عن الرابط المحفوظ فعلاً.
 */
export function toAbsoluteMediaUrl(value: string | null | undefined): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.toString() : null;
  } catch {
    return null;
  }
}

async function insertStoryReplyPayload(payload: MessageInsertPayload): Promise<StoryReplyInsertResult> {
  const { error } = await supabase.from('messages').insert(payload);
  return { error: toStoryReplyInsertError(error) };
}

// أعمدة اختيارية يمكن إسقاطها منفردة عند تأكيد غيابها في قاعدة قديمة، مع
// الاحتفاظ ببقية البيانات في كل محاولة.
const OPTIONAL_STORY_COLUMNS = [
  'story_reply',
  'story_id',
  'story_media_url',
  'story_thumbnail_url',
  'story_media_type',
] as const;

type OptionalStoryColumn = (typeof OPTIONAL_STORY_COLUMNS)[number];

// PGRST204 يعني أن مخطط PostgREST المخزّن مؤقتاً لا يعرف العمود، وقد يكون
// خطأً عابراً بعد إضافة أعمدة حديثاً. نعيد المحاولة بالحمولة نفسها قبل أي حذف،
// ولا نُسقط أي عمود بسبب هذا الكود إطلاقاً.
const SCHEMA_CACHE_CODE = 'PGRST204';
const MISSING_COLUMN_CODE = '42703';
const MAX_SCHEMA_CACHE_RETRIES = 2;

function isSchemaCacheError(error: StoryReplyInsertError): boolean {
  return error.code === SCHEMA_CACHE_CODE;
}

/**
 * دليل صريح على غياب عمود فعلياً في PostgreSQL: الكود 42703 أو نص
 * «column ... does not exist». لا نستخدم نص PGRST204 («Could not find the
 * '...' column ... schema cache») هنا لأنه قد يعني مخططاً مخزّناً مؤقتاً فقط.
 */
function isMissingColumnError(error: StoryReplyInsertError): boolean {
  if (error.code === MISSING_COLUMN_CODE) return true;
  const text = insertErrorText(error).toLowerCase();
  return /column .*does not exist/.test(text);
}

/** أسماء الأعمدة الاختيارية المذكورة صراحةً في خطأ غياب عمود فعلي. */
function namedOptionalColumns(
  error: StoryReplyInsertError,
  payload: MessageInsertPayload,
): OptionalStoryColumn[] {
  if (!isMissingColumnError(error)) return [];
  const text = insertErrorText(error).toLowerCase();
  return OPTIONAL_STORY_COLUMNS.filter(
    column => Object.prototype.hasOwnProperty.call(payload, column) && text.includes(column),
  );
}

export async function sendStoryReplyMessage(input: StoryReplyInsertInput): Promise<StoryReplyInsertResult> {
  const payload: MessageInsertPayload = {
    sender_id: input.senderId,
    recipient_id: input.recipientId,
    content: input.text,
    story_reply: true,
  };
  if (input.storyId) payload.story_id = input.storyId;
  if (input.storyMediaUrl) payload.story_media_url = input.storyMediaUrl;
  if (input.storyThumbnailUrl) payload.story_thumbnail_url = input.storyThumbnailUrl;
  if (input.storyMediaType) payload.story_media_type = input.storyMediaType;

  let legacyTagApplied = false;
  let firstFailureLogged = false;
  let cacheRetries = 0;
  let lastResult: StoryReplyInsertResult = { error: null };

  for (let attempt = 0; attempt < OPTIONAL_STORY_COLUMNS.length + 4; attempt += 1) {
    lastResult = await insertStoryReplyPayload(payload);
    if (!lastResult.error) {
      if (attempt > 0) {
        console.info('[story reply] نجح الإدراج بعد محاولة توافق.', {
          attempt,
          columnsInPayload: Object.keys(payload).length,
        });
      }
      return lastResult;
    }

    if (!firstFailureLogged) {
      firstFailureLogged = true;
      // تشخيص بلا نص رسالة PostgREST وبلا أي محتوى أو بيانات شخصية:
      // كود الخطأ وتصنيفه العام فقط.
      console.warn('[story reply] تعذر إدراج الرد في messages؛ فحص إمكانية تراجع توافقي.', {
        code: lastResult.error.code ?? 'unknown',
        category: classifyInsertFailure(lastResult.error),
      });
    }

    // 1) مخطط مخزّن مؤقتاً: إعادة الإدراج بالحمولة الأصلية نفسها مرتين،
    //    دون حذف أي عمود ودون تعديل المحتوى.
    if (isSchemaCacheError(lastResult.error)) {
      if (cacheRetries < MAX_SCHEMA_CACHE_RETRIES) {
        cacheRetries += 1;
        continue;
      }
      console.warn('[story reply] استمر خطأ مخطط PostgREST بعد إعادة المحاولة؛ إيقاف بلا إسقاط أعمدة.', {
        code: lastResult.error.code ?? 'unknown',
        category: classifyInsertFailure(lastResult.error),
        retries: cacheRetries,
      });
      return lastResult;
    }
    cacheRetries = 0;

    // 2) إسقاط توافقي فقط عند دليل صريح على غياب العمود (42703).
    const named = namedOptionalColumns(lastResult.error, payload);
    if (named.length === 0) {
      // صلاحيات/RLS/اتصال/قيد: ليست مشكلة عمود مفقود، فلا مسار توافقي.
      return lastResult;
    }

    for (const column of named) delete payload[column];
    console.warn('[story reply] إسقاط أعمدة اختيارية من محاولة الإدراج.', {
      code: lastResult.error.code ?? 'unknown',
      columns: named.join(','),
    });

    // غياب عمود story_reply فقط: نُبقي story_id وروابط الوسائط ونوعها،
    // ونستخدم الوسم القديم كعلامة بديلة.
    if (named.includes('story_reply') && !legacyTagApplied) {
      payload.content = `${LEGACY_STORY_REPLY_PREFIX}${input.text}`;
      legacyTagApplied = true;
    }
  }

  return lastResult;
}
