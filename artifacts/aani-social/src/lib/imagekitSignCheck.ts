// أداة تشخيص مؤقتة لتوقيع ImageKit — تُحذف بعد انتهاء الاختبار.
//
// ما تفعله، لكل مسار:
//   1. تطلب توقيعاً من /api/media/imagekit-sign بنفس شكل الطلب الذي يستخدمه
//      src/lib/mediaAccess.ts (جلسة Supabase الحالية في ترويسة Authorization).
//   2. تفتح الرابط الموقّع وتقرأ حالته (200 = التوقيع مقبول).
//   3. تفتح **نفس الرابط بلا ik-t/ik-s** وتقرأ حالته: الرفض 401/403 يثبت أن
//      الملف خاص فعلاً، و200 يثبت أنه عام.
//
// لماذا الخطوة الثالثة: ملفات الحساب الحالية عامة، فـ200 على رابط موقّع لا
// يثبت أن التوقيع يعمل — الرابط العام يعمل أيضاً. الدليل الوحيد بلا تفعيل
// Restrict unsigned URLs على الحساب كله هو ملف واحد مُعلَّم Private: بلا توقيع
// يُرفض، وبتوقيع يُفتح. لذلك الاختبار يقبل «ملف اختبار خاص» يُعدّه المستخدم
// بنفسه في ImageKit، ويحكم على النتيجة من اقتران الخطوتين لا من 200 وحدها.
//
// ما لا تفعله: لا ترفع أي ملف، ولا تفعّل VITE_IMAGEKIT_SIGNED_URLS، ولا تغيّر
// إعداد ImageKit أو Render أو Supabase، ولا تكتب أو تحذف أي صف أو ملف، ولا
// تعرض أي مفتاح أو access token أو الرابط الموقّع نفسه.

import { parseImageKitPath } from '@/lib/mediaAccess';
import { supabase } from '@/lib/supabase';

export type ImageKitCandidateSource =
  | 'ملف اختبار خاص'
  | 'صورة الملف الشخصي'
  | 'غلاف الملف الشخصي'
  | 'منشور'
  | 'قصة'
  | 'مسار يدوي';

export type ImageKitSignCandidate = {
  source: ImageKitCandidateSource;
  /** مسار ImageKit كما يصل إلى الخادم: /<endpoint>/aani/<userId>/<file> */
  path: string;
  /** ملف الاختبار الخاص الذي أعدّه المستخدم لهذا الغرض تحديداً. */
  isPrivateTestFile?: boolean;
};

export type ImageKitSignStep = {
  state: 'ok' | 'failed' | 'unknown';
  status: number | null;
  message: string;
};

export type ImageKitSignCheckResult = {
  candidate: ImageKitSignCandidate;
  /** خطوة 1: هل أعاد الخادم رابطاً موقّعاً؟ */
  sign: ImageKitSignStep;
  /** خطوة 2: هل يُفتح الرابط الموقّع؟ */
  open: ImageKitSignStep;
  /** خطوة 3: هل يُرفض الملف بلا توقيع (أي أنه خاص فعلاً)؟ */
  unsigned: ImageKitSignStep;
  /** دليل قاطع: الملف خاص (رُفض بلا توقيع) والموقّع فُتح 200. */
  provesSigning: boolean;
  /** الملف عام: 200 الموقّع لا يثبت صحة التوقيع. */
  isPublicFile: boolean;
};

const UNKNOWN_STEP: ImageKitSignStep = {
  state: 'unknown',
  status: null,
  message: 'لم يُنفَّذ — لا رابط موقّع لفتحه.',
};

/** يحوّل قيمة مخزّنة في القاعدة إلى مرشّح، أو null إن لم تكن رابط ImageKit. */
function toCandidateFromUrl(source: ImageKitCandidateSource, raw: unknown): ImageKitSignCandidate | null {
  if (typeof raw !== 'string') return null;
  const path = parseImageKitPath(raw);
  if (!path) return null;
  return { source, path };
}

function parseInput(raw: string): string | null {
  const value = raw.trim();
  if (!value) return null;
  if (/^https?:\/\//i.test(value)) return parseImageKitPath(value);
  if (!value.startsWith('/')) return null;
  const path = value.split('?')[0].split('#')[0];
  return path.length > 1 ? path : null;
}

/** مسار يدوي (رابط ImageKit كامل أو مسار مطلق يبدأ بـ"/"). */
export function toCandidateFromInput(raw: string): ImageKitSignCandidate | null {
  const path = parseInput(raw);
  return path ? { source: 'مسار يدوي', path } : null;
}

/** مسار ملف الاختبار الخاص الذي أعدّه المستخدم في ImageKit. */
export function toPrivateTestFileCandidate(raw: string): ImageKitSignCandidate | null {
  const path = parseInput(raw);
  return path ? { source: 'ملف اختبار خاص', path, isPrivateTestFile: true } : null;
}

/**
 * يجمع مسارات المرشّحين من صفوف المستخدم نفسه فقط (أدلة إضافية، لا دليل قاطع:
 * هذه الملفات عامة اليوم). كل استعلام قراءة محضة ومحدود بـuser_id.
 */
export async function collectOwnImageKitCandidates(userId: string): Promise<{
  candidates: ImageKitSignCandidate[];
  problems: string[];
}> {
  const candidates: ImageKitSignCandidate[] = [];
  const problems: string[] = [];
  const seen = new Set<string>();
  const add = (source: ImageKitCandidateSource, raw: unknown) => {
    const candidate = toCandidateFromUrl(source, raw);
    if (!candidate || seen.has(candidate.path)) return;
    seen.add(candidate.path);
    candidates.push(candidate);
  };

  // cover_url قد لا يوجد في قاعدة أقدم — يُعاد بالعمود الأساسي وحده بدل
  // إسقاط صورة الملف كلها.
  const profileSelects = ['avatar_url, cover_url', 'avatar_url'];
  for (const select of profileSelects) {
    try {
      const { data, error } = await supabase
        .from('profiles')
        .select(select)
        .eq('id', userId)
        .maybeSingle();
      if (error) {
        problems.push(`تعذّر قراءة صف الملف الشخصي (${select}): ${error.message}`);
        continue;
      }
      const row = data as { avatar_url?: string | null; cover_url?: string | null } | null;
      add('صورة الملف الشخصي', row?.avatar_url);
      add('غلاف الملف الشخصي', row?.cover_url);
      break;
    } catch {
      problems.push('تعذّر قراءة صف الملف الشخصي.');
      break;
    }
  }

  try {
    const { data, error } = await supabase
      .from('posts')
      .select('id, media_url, media_urls')
      .eq('user_id', userId)
      .limit(5);
    if (error) {
      problems.push(`تعذّر قراءة منشوراتك: ${error.message}`);
    } else {
      const rows = (data ?? []) as Array<{ media_url?: string | null; media_urls?: unknown }>;
      for (const row of rows) {
        add('منشور', row.media_url);
        if (Array.isArray(row.media_urls)) {
          for (const url of row.media_urls) add('منشور', url);
        }
      }
    }
  } catch {
    problems.push('تعذّر قراءة منشوراتك.');
  }

  // thumbnail_url قد لا يوجد في قاعدة أقدم — يُعاد بلا الأعمدة الإضافية بدل
  // إسقاط القصص كلها.
  const storySelects = ['id, media_url, thumbnail_url', 'id, media_url'];
  for (const select of storySelects) {
    try {
      const { data, error } = await supabase
        .from('stories')
        .select(select)
        .eq('user_id', userId)
        .limit(5);
      if (error) {
        problems.push(`تعذّر قراءة قصصك (${select}): ${error.message}`);
        continue;
      }
      const rows = (data ?? []) as Array<{ media_url?: string | null; thumbnail_url?: string | null }>;
      for (const row of rows) {
        add('قصة', row.media_url);
        add('قصة', row.thumbnail_url);
      }
      break;
    } catch {
      problems.push('تعذّر قراءة قصصك.');
      break;
    }
  }

  return { candidates: candidates.slice(0, 6), problems };
}

/** سبب الفشل بكلمات مفهومة — لا يكشف مفتاحاً ولا رمز جلسة. */
function explainSignFailure(status: number, serverError: unknown): string {
  const base = `فشل التوقيع (HTTP ${status})`;
  if (status === 400) return `${base}: المسار غير مقبول — يجب أن يكون مسار ImageKit مطلقاً بلا استعلام.`;
  if (status === 401) return `${base}: الجلسة غير صالحة أو منتهية — أعد تسجيل الدخول ثم أعد الاختبار.`;
  if (status === 403) {
    return `${base}: منع الخادم التوقيع لأن aani_can_read_media_object رفضت هذا الملف لهذا المستخدم — تأكد أن المسار داخل مجلدك /aani/<userId>/ وأن ترحيل قرار الوسائط مطبَّق.`;
  }
  if (status === 503) {
    return `${base}: الخادم غير مهيأ — IMAGEKIT_URL_ENDPOINT أو IMAGEKIT_PRIVATE_KEY أو إعدادات Supabase ناقصة على الخدمة.`;
  }
  if (status === 500) return `${base}: خطأ داخلي في الخادم — راجع سجل Render.`;
  const detail = typeof serverError === 'string' ? serverError.trim() : '';
  return detail ? `${base}: ${detail.slice(0, 160)}` : base;
}

/**
 * يطلب رابطاً موقّعاً من /api/media/imagekit-sign بجلسة Supabase الحالية.
 * الـaccess token يبقى في ترويسة الطلب فقط: لا يُخزَّن ولا يُعرض ولا يُنسخ.
 */
async function requestSignedUrl(path: string): Promise<{ step: ImageKitSignStep; signedUrl: string | null }> {
  let accessToken = '';
  try {
    const { data } = await supabase.auth.getSession();
    accessToken = data.session?.access_token || '';
  } catch {
    accessToken = '';
  }
  if (!accessToken) {
    return {
      step: { state: 'failed', status: null, message: 'لا توجد جلسة Supabase نشطة — سجّل الدخول ثم أعد الاختبار.' },
      signedUrl: null,
    };
  }

  let response: Response;
  try {
    response = await fetch(`/api/media/imagekit-sign?path=${encodeURIComponent(path)}`, {
      headers: { authorization: `Bearer ${accessToken}` },
      cache: 'no-store',
    });
  } catch {
    return {
      step: { state: 'failed', status: null, message: 'تعذّر الوصول إلى /api/media/imagekit-sign (شبكة أو تحويل مسار على الخادم).' },
      signedUrl: null,
    };
  }

  const payload = (await response.json().catch(() => null)) as
    | { success?: unknown; url?: unknown; expire?: unknown; error?: unknown }
    | null;

  const signedUrl = typeof payload?.url === 'string' ? payload.url : '';
  if (!response.ok || payload?.success !== true || !signedUrl) {
    return {
      step: { state: 'failed', status: response.status, message: explainSignFailure(response.status, payload?.error) },
      signedUrl: null,
    };
  }

  let expire: number | null = null;
  if (payload && typeof payload.expire === 'number') expire = payload.expire;
  let expiryText = '';
  try {
    if (expire) expiryText = ` صالح حتى ${new Date(expire * 1000).toLocaleString('ar')}.`;
  } catch {
    expiryText = '';
  }

  return {
    step: { state: 'ok', status: response.status, message: `أعاد الخادم رابطاً موقّعاً (HTTP ${response.status}).${expiryText}` },
    signedUrl,
  };
}

/**
 * قراءة حالة استجابة واحدة. credentials: 'omit' حتى لا يُرسل أي كوكي جلسة
 * إلى مضيف ImageKit — الطلب لا يحتاج إلا التوقيع في المسار.
 */
async function readStatus(url: string, method: 'HEAD' | 'GET'): Promise<number | null> {
  try {
    const response = await fetch(url, { method, cache: 'no-store', credentials: 'omit' });
    if (method === 'GET' && response.body) {
      try {
        await response.body.cancel();
      } catch {
        // لا شيء: الجسم لا يُقرأ في اختبار الحالة.
      }
    }
    return response.status;
  } catch {
    return null;
  }
}

function explainOpenStatus(status: number, via: 'HEAD' | 'GET'): ImageKitSignStep {
  if (status === 200) return { state: 'ok', status, message: `فُتح الرابط الموقّع بنجاح (HTTP 200 عبر ${via}).` };
  if (status === 401 || status === 403) {
    return {
      state: 'failed',
      status,
      message: `رفض ImageKit الرابط الموقّع (HTTP ${status} عبر ${via}) — غالباً IMAGEKIT_PRIVATE_KEY لا يطابق الـendpoint، أو المسار المُوقَّع لا يطابق المطلوب.`,
    };
  }
  if (status === 404) {
    return {
      state: 'failed',
      status,
      message: `الملف غير موجود على ImageKit (HTTP 404 عبر ${via}) — المسار لا يقابل ملفاً فعلياً.`,
    };
  }
  return { state: 'failed', status, message: `استجابة غير متوقعة من ImageKit (HTTP ${status} عبر ${via}).` };
}

/**
 * يفتح الرابط الموقّع فعلياً ويقرأ حالته.
 *
 * HEAD أولاً لأنه خفيف، لكن **حالة HEAD غير الناجحة ليست حكماً**: بعض المضيفين
 * والإعدادات ترفض HEAD (403/405) أو تحجبه، فيُعاد الطلب بـGET دائماً قبل
 * الحكم — لا عند فشل الشبكة وحده.
 */
async function openSignedUrl(url: string): Promise<ImageKitSignStep> {
  const head = await readStatus(url, 'HEAD');
  if (head === 200) return explainOpenStatus(200, 'HEAD');

  const get = await readStatus(url, 'GET');
  if (get !== null) return explainOpenStatus(get, 'GET');

  if (head === null) {
    return {
      state: 'unknown',
      status: null,
      message: 'تعذّر قراءة حالة الاستجابة من المتصفح (CORS أو قطع شبكة) — التوقيع أُنشئ، لكن فتح الرابط لم يُتحقق منه من هنا.',
    };
  }
  // HEAD أعاد حالة (غير 200) وGET تعذّر: لا نجزم برفض التوقيع من HEAD وحده.
  return {
    state: 'unknown',
    status: head,
    message: `HEAD أعاد HTTP ${head} لكن GET تعذّر (شبكة/CORS) — لا حكم على الرابط بهذه الحالة.`,
  };
}

/** الرابط نفسه بلا ik-t/ik-s — لمقارنة ما يحدث بلا توقيع. */
function stripSignature(url: string): string | null {
  try {
    const parsed = new URL(url);
    parsed.searchParams.delete('ik-t');
    parsed.searchParams.delete('ik-s');
    parsed.hash = '';
    return parsed.toString();
  } catch {
    return null;
  }
}

/**
 * يفتح الملف بلا توقيع. هذه الخطوة هي التي تحدد قيمة كل ما قبلها:
 *   - 401/403 ⇒ الملف خاص فعلاً (Private file): نجاح الموقّع دليل على التوقيع.
 *   - 200     ⇒ الملف عام، فنجاح الموقّع لا يثبت شيئاً.
 */
async function probeUnsigned(signedUrl: string): Promise<ImageKitSignStep> {
  const plain = stripSignature(signedUrl);
  if (!plain) return { state: 'unknown', status: null, message: 'تعذّر تكوين رابط بلا توقيع للمقارنة.' };

  const status = await readStatus(plain, 'GET');
  if (status === null) {
    return {
      state: 'unknown',
      status: null,
      message: 'تعذّرت قراءة حالة الرابط بلا توقيع (شبكة/CORS) — لا دليل على أن الملف خاص.',
    };
  }
  if (status === 401 || status === 403) {
    return {
      state: 'ok',
      status,
      message: `رُفض بلا توقيع (HTTP ${status}) — الملف خاص فعلاً، فقبول الموقّع دليل على صحة التوقيع.`,
    };
  }
  if (status === 200) {
    return {
      state: 'unknown',
      status,
      message: 'يُفتح بلا توقيع (HTTP 200) — الملف عام، فنجاح الرابط الموقّع لا يثبت صحة التوقيع.',
    };
  }
  if (status === 404) {
    return { state: 'failed', status, message: 'لا ملف على هذا المسار (HTTP 404) — تحقق من المسار في ImageKit.' };
  }
  return { state: 'unknown', status, message: `استجابة غير متوقعة بلا توقيع (HTTP ${status}).` };
}

/** توقيع مرشّح واحد، ثم فتح الموقّع، ثم فتحه بلا توقيع للمقارنة. */
export async function runImageKitSignCheck(candidate: ImageKitSignCandidate): Promise<ImageKitSignCheckResult> {
  const { step: sign, signedUrl } = await requestSignedUrl(candidate.path);
  if (!signedUrl) {
    return { candidate, sign, open: UNKNOWN_STEP, unsigned: UNKNOWN_STEP, provesSigning: false, isPublicFile: false };
  }

  const open = await openSignedUrl(signedUrl);
  const unsigned = await probeUnsigned(signedUrl);

  return {
    candidate,
    sign,
    open,
    unsigned,
    provesSigning: open.state === 'ok' && unsigned.state === 'ok',
    isPublicFile: unsigned.status === 200,
  };
}
