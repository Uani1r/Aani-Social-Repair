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
  name?: string;
  details?: string;
  hint?: string;
}

export interface StoryReplyInsertResult {
  error: StoryReplyInsertError | null;
  /** أُرسلت الرسالة لكن تعذّر تثبيت حقول معاينة الستوري عليها. */
  warning?: 'preview-not-saved';
  /** لم يتأكد إدراج الرسالة ولم يُنفَ (انقطاع اتصال/إلغاء)؛ تحقق من المحادثة. */
  uncertain?: true;
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
      name: typeof record.name === 'string' ? record.name : undefined,
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
 * أخطاء النقل/الشبكة قد تصل داخل { error } دون استثناء (fetch reject في
 * مكتبة Supabase). هذه النتيجة غير محسومة، بخلاف أخطاء PostgreSQL الصريحة
 * (RLS/قيود/مخطط) التي تحمل SQLSTATE أو رمز PGRST.
 */
function isTransportLikeInsertError(error: StoryReplyInsertError): boolean {
  const code = (error.code ?? '').toUpperCase();
  if (/^[0-9A-Z]{5}$/.test(code) || code.startsWith('PGRST')) return false;

  const name = (error.name ?? '').toLowerCase();
  if (name === 'aborterror' || name === 'networkerror') return true;

  const text = [error.message, error.details, error.hint]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
  if (!text) return false;

  return text.includes('failed to fetch')
    || text.includes('fetch failed')
    || text.includes('networkerror')
    || text.includes('network error')
    || text.includes('network request failed')
    || text.includes('load failed')
    || text.includes('network connection was lost')
    || text.includes('internet connection appears to be offline')
    || text.includes('timed out')
    || text.includes('timeout');
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

type MessageExistence = 'found' | 'not-found' | 'unknown';

// قد يصل طلب الإدراج إلى الخادم ويُحفظ بعد انقطاع التأكيد؛ لذلك لا نعتبر
// «عدم العثور» نهائياً إلا بعد محاولات متعددة بفواصل قصيرة متدرجة.
const VERIFY_DELAYS_MS = [0, 250, 700, 1300, 2200] as const;

function wait(ms: number): Promise<void> {
  return new Promise(resolve => {
    window.setTimeout(resolve, ms);
  });
}

/** محاولة تحقق واحدة بالمعرّف الذي أُنشئ قبل الإدراج + المرسل + المستلم. */
async function findStoryReplyMessageOnce(
  messageId: string,
  senderId: string,
  recipientId: string,
): Promise<MessageExistence> {
  try {
    const { data, error } = await supabase
      .from('messages')
      .select('id')
      .eq('id', messageId)
      .eq('sender_id', senderId)
      .eq('recipient_id', recipientId)
      .maybeSingle();
    if (error) {
      // فشل قراءة/اتصال: النتيجة غير محسومة، وليست دليل عدم وجود.
      console.warn('[story reply] stage=insert-verify unreadable', { code: error.code ?? 'unknown' });
      return 'unknown';
    }
    return data ? 'found' : 'not-found';
  } catch (error) {
    const name = error && typeof error === 'object' && 'name' in error
      ? String((error as { name?: unknown }).name ?? 'unknown')
      : 'unknown';
    console.warn('[story reply] stage=insert-verify threw', { name });
    return 'unknown';
  }
}

/**
 * تحقق متكرر بعد استثناء الإدراج. تعود 'found' عند أول ظهور، و'unknown'
 * فور أي فشل قراءة/إلغاء، و'not-found' فقط بعد نجاح كل المحاولات بلا صف.
 * لا تُعيد الإدراج ولا تُنشئ معرّفاً جديداً.
 */
async function waitForStoryReplyMessage(
  messageId: string,
  senderId: string,
  recipientId: string,
): Promise<MessageExistence> {
  for (let attempt = 0; attempt < VERIFY_DELAYS_MS.length; attempt += 1) {
    const delay = VERIFY_DELAYS_MS[attempt];
    if (delay > 0) await wait(delay);

    const existence = await findStoryReplyMessageOnce(messageId, senderId, recipientId);
    if (existence !== 'not-found') {
      if (existence === 'found' && attempt > 0) {
        console.info('[story reply] stage=insert-verify found on retry', { attempt: attempt + 1 });
      }
      return existence;
    }
  }

  console.warn('[story reply] stage=insert-verify not found after retries', {
    attempts: VERIFY_DELAYS_MS.length,
  });
  return 'not-found';
}

async function insertStoryReplyPayload(payload: MessageInsertPayload): Promise<StoryReplyInsertResult> {
  try {
    const { error } = await supabase.from('messages').insert(payload);
    const insertError = toStoryReplyInsertError(error);
    if (insertError && isTransportLikeInsertError(insertError)) {
      // خطأ نقل وصل داخل { error } وليس استثناءً: النتيجة غير محسومة.
      return { error: insertError, uncertain: true };
    }
    return { error: insertError };
  } catch (error) {
    // استثناء في طلب الإدراج: النتيجة غير محسومة، وتُحسم عبر التحقق بالمعرّف.
    return { error: toStoryReplyInsertError(error), uncertain: true };
  }
}

/** إدراج ناجح مؤكد: تحقق المعاينة غير حاجز ولا يغيّر نتيجة الإرسال. */
async function finishSuccessfulInsert(
  messageId: string,
  input: StoryReplyInsertInput,
  payload: MessageInsertPayload,
): Promise<StoryReplyInsertResult> {
  try {
    const verification = await verifyStoryReplyFields(messageId, input.senderId, payload);
    return { error: null, ...verification };
  } catch (verificationError) {
    const name = verificationError && typeof verificationError === 'object' && 'name' in verificationError
      ? String((verificationError as { name?: unknown }).name ?? 'unknown')
      : 'unknown';
    const code = verificationError && typeof verificationError === 'object' && 'code' in verificationError
      ? String((verificationError as { code?: unknown }).code ?? '')
      : '';
    console.warn('[story reply] stage=verify post-insert failed', {
      name,
      code: code || 'unknown',
    });
    return { error: null, warning: 'preview-not-saved' };
  }
}

function createReplyMessageId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, character => {
    const random = Math.floor(Math.random() * 16);
    return (character === 'x' ? random : (random & 0x3) | 0x8).toString(16);
  });
}

const VERIFY_COLUMNS = 'story_reply, story_id, story_media_url, story_thumbnail_url, story_media_type';
const STORY_FIELD_KEYS = [
  'story_reply',
  'story_id',
  'story_media_url',
  'story_thumbnail_url',
  'story_media_type',
] as const;

/**
 * بعد نجاح الإدراج نقرأ الصف مرة واحدة ونتحقق أن الحقول التي أرسلناها فعلاً
 * موجودة. إن كانت NULL رغم نجاح الإدراج (مشغّل، مخطط قديم، أو عميل قديم)،
 * نثبّتها بتحديث على نفس الصف. الفشل هنا لا يُعاد كخطأ إرسال لأن الرسالة أُرسلت
 * بالفعل، لكنه لا يُخفى: يُعاد warning صريح ويُسجّل كود الخطأ فقط.
 */
async function readStoryReplyFields(
  messageId: string,
  senderId: string,
): Promise<{ row: Record<string, unknown> | null; code: string }> {
  const { data, error } = await supabase
    .from('messages')
    .select(VERIFY_COLUMNS)
    .eq('id', messageId)
    .eq('sender_id', senderId)
    .maybeSingle();

  if (error) return { row: null, code: error.code ?? 'unknown' };
  if (!data) return { row: null, code: 'no-rows' };
  return { row: data as unknown as Record<string, unknown>, code: '' };
}

/** الحقول التي أرسلناها ولم تطابق القراءة الفعلية من الصف. */
function mismatchedStoryFields(
  expected: MessageInsertPayload,
  row: Record<string, unknown>,
): MessageInsertPayload {
  const missing: MessageInsertPayload = {};
  for (const [key, value] of Object.entries(expected)) {
    const actual = row[key];
    const matches = value === true
      ? actual === true
      : (actual ?? null) === (value ?? null);
    if (!matches) missing[key] = value;
  }
  return missing;
}

/**
 * بعد نجاح الإدراج نقرأ الصف ونتحقق أن الحقول التي أرسلناها فعلاً موجودة،
 * ونثبّتها بتحديث على نفس الصف إن كانت NULL، ثم نعيد القراءة للتحقق من
 * التثبيت. أي تعذّر في القراءة أو عدم مطابقة بعد التحديث يُعاد كتحذير صريح
 * (رسالة أُرسلت، لكن معاينتها لم تُحفظ) ولا يُسجَّل معه محتوى أو روابط.
 */
async function verifyStoryReplyFields(
  messageId: string,
  senderId: string,
  sentPayload: MessageInsertPayload,
): Promise<Pick<StoryReplyInsertResult, 'warning'>> {
  const expected: MessageInsertPayload = {};
  for (const key of STORY_FIELD_KEYS) {
    if (Object.prototype.hasOwnProperty.call(sentPayload, key)) expected[key] = sentPayload[key];
  }
  if (Object.keys(expected).length === 0) return {};

  const firstRead = await readStoryReplyFields(messageId, senderId);
  if (!firstRead.row) {
    // تعذر التحقق (صلاحيات/شبكة/صف غير موجود): لا نُعلن نجاحاً كاملاً.
    console.warn('[story reply] stage=verify unreadable', { code: firstRead.code });
    return { warning: 'preview-not-saved' };
  }

  const missing = mismatchedStoryFields(expected, firstRead.row);
  if (Object.keys(missing).length === 0) return {};

  const { data: updated, error: updateError } = await supabase
    .from('messages')
    .update(missing)
    .eq('id', messageId)
    .eq('sender_id', senderId)
    .select('id');

  if (updateError || !updated || updated.length === 0) {
    console.warn('[story reply] stage=preview-heal failed', {
      code: updateError?.code ?? 'no-rows',
    });
    return { warning: 'preview-not-saved' };
  }

  // إرجاع id وحده لا يكفي: نعيد قراءة الحقول الخمسة ونتحقق من مطابقتها.
  const secondRead = await readStoryReplyFields(messageId, senderId);
  if (!secondRead.row) {
    console.warn('[story reply] stage=preview-heal verify unreadable', { code: secondRead.code });
    return { warning: 'preview-not-saved' };
  }

  const stillMismatched = mismatchedStoryFields(expected, secondRead.row);
  if (Object.keys(stillMismatched).length > 0) {
    console.warn('[story reply] stage=preview-heal verify mismatch', {
      fields: Object.keys(stillMismatched).length,
    });
    return { warning: 'preview-not-saved' };
  }

  console.info('[story reply] stage=preview-heal succeeded', { fields: Object.keys(missing).length });
  return {};
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
  // معرّف من العميل: يسمح بالتحقق من الصف بعد الإدراج وتثبيت الحقول عليه إن
  // لزم، دون البحث عن الرسالة بالنص (وهو غير موثوق وقد يطابق رسالة أخرى).
  const messageId = createReplyMessageId();
  const payload: MessageInsertPayload = {
    id: messageId,
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
      return finishSuccessfulInsert(messageId, input, payload);
    }

    // استثناء/انقطاع أثناء طلب الإدراج: النتيجة غير محسومة. نتحقق بالمعرّف
    // الذي أُنشئ قبل الإدراج، ولا نُعيد الإدراج بمعرّف آخر إطلاقاً.
    if (lastResult.uncertain) {
      const existence = await waitForStoryReplyMessage(messageId, input.senderId, input.recipientId);
      if (existence === 'found') {
        console.info('[story reply] stage=insert-verify found after transport error');
        return finishSuccessfulInsert(messageId, input, payload);
      }
      if (existence === 'unknown') {
        console.warn('[story reply] stage=insert-verify unknown', {
          name: lastResult.error?.name ?? 'unknown',
          code: lastResult.error?.code ?? 'unknown',
        });
        // لا نُعلن فشلاً مؤكداً ولا نجاحاً: الواجهة تعرض حالة غير مؤكدة.
        return { error: null, uncertain: true };
      }
      // لم يظهر الصف بعد كل المحاولات، لكن هذا لا يثبت أن الإدراج لم يُحفظ؛
      // فقد يكتمل الطلب بعد انتهاء التحقق. نُبقي النتيجة غير مؤكدة، ونحفظ
      // الخطأ الأصلي في السجل التقني فقط (كود/اسم) دون أي تنبيه فشل مؤكد.
      console.warn('[story reply] stage=insert-verify not found after retries; keeping uncertain', {
        name: lastResult.error?.name ?? 'unknown',
        code: lastResult.error?.code ?? 'unknown',
        category: lastResult.error ? classifyInsertFailure(lastResult.error) : 'unknown',
      });
      return { error: null, uncertain: true };
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
