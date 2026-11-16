// أداة تشخيص مؤقتة لتوقيع ImageKit — تُحذف بعد انتهاء الاختبار.
//
// ما تفعله:
//   1. تجمع مسارات ImageKit حقيقية تخص المستخدم الحالي من القاعدة بجلسته
//      (صورة الملف الشخصي، غلافه، منشوراته، قصصه) — قراءة فقط.
//   2. تطلب توقيع أحدها من /api/media/imagekit-sign بنفس شكل الطلب الذي
//      يستخدمه src/lib/mediaAccess.ts، فلا تختبر مساراً مختلفاً عن الإنتاج.
//   3. تفتح الرابط الموقّع وتقرأ حالة الاستجابة (HTTP 200 = نجاح).
//
// ما لا تفعله: لا تفعّل VITE_IMAGEKIT_SIGNED_URLS، ولا تغيّر إعداد ImageKit
// أو Supabase، ولا ترفع ملفات بـisPrivateFile، ولا تكتب أو تحذف أي صف أو ملف.
// ولا تعرض أي مفتاح أو access token أو الرابط الموقّع نفسه — التوقيع اعتماد
// مؤقت لساعة، فلا يُعرض ولا يُنقل.

import { parseImageKitPath } from '@/lib/mediaAccess';
import { supabase } from '@/lib/supabase';

export type ImageKitCandidateSource =
  | 'صورة الملف الشخصي'
  | 'غلاف الملف الشخصي'
  | 'منشور'
  | 'قصة'
  | 'مسار يدوي';

export type ImageKitSignCandidate = {
  source: ImageKitCandidateSource;
  /** مسار ImageKit كما يصل إلى الخادم: /<endpoint>/aani/<userId>/<file> */
  path: string;
};

export type ImageKitSignStep = {
  state: 'ok' | 'failed' | 'unknown';
  status: number | null;
  message: string;
};

export type ImageKitSignCheckResult = {
  candidate: ImageKitSignCandidate;
  sign: ImageKitSignStep;
  open: ImageKitSignStep;
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

/** مسار يدوي: رابط ImageKit كامل أو مسار مطلق يبدأ بـ"/". */
export function toCandidateFromInput(raw: string): ImageKitSignCandidate | null {
  const value = raw.trim();
  if (!value) return null;
  if (/^https?:\/\//i.test(value)) return toCandidateFromUrl('مسار يدوي', value);
  if (!value.startsWith('/')) return null;
  const path = value.split('?')[0].split('#')[0];
  return path.length > 1 ? { source: 'مسار يدوي', path } : null;
}

/**
 * يجمع مسارات المرشّحين من صفوف المستخدم نفسه فقط.
 * كل استعلام قراءة محضة ومحدود بـuser_id، فلا يلمس بيانات أحد آخر.
 * فشل أي مصدر لا يوقف الباقي — يُذكر سبب تخطّيه.
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
    return `${base}: منع الخادم التوقيع لأن aani_can_read_media_object رفضت هذا الملف لهذا المستخدم — تأكد أن المسار يخصّك وأن ترحيل قرار الوسائط مطبَّق.`;
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
 * يفتح الرابط الموقّع فعلياً ويقرأ حالته.
 * HEAD أولاً (خفيف) ثم GET إن رفضه المضيف. credentials: 'omit' حتى لا يُرسل
 * أي كوكي جلسة إلى مضيف ImageKit — الطلب لا يحتاج إلا التوقيع في المسار.
 */
async function openSignedUrl(url: string): Promise<ImageKitSignStep> {
  let status: number | null = null;
  for (const method of ['HEAD', 'GET'] as const) {
    try {
      const response = await fetch(url, { method, cache: 'no-store', credentials: 'omit' });
      status = response.status;
      if (method === 'GET' && response.body) {
        try {
          await response.body.cancel();
        } catch {
          // لا شيء: الجسم لا يُقرأ في اختبار الحالة.
        }
      }
      break;
    } catch {
      status = null;
    }
  }

  if (status === null) {
    return {
      state: 'unknown',
      status: null,
      message: 'تعذّر قراءة حالة الاستجابة من المتصفح (CORS أو قطع شبكة) — التوقيع أُنشئ، لكن فتح الرابط لم يُتحقق منه من هنا.',
    };
  }
  if (status === 200) return { state: 'ok', status, message: 'فُتح الرابط الموقّع بنجاح (HTTP 200) — التوقيع مقبول على هذا الملف.' };
  if (status === 401 || status === 403) {
    return {
      state: 'failed',
      status,
      message: `رفض ImageKit الرابط الموقّع (HTTP ${status}) — غالباً IMAGEKIT_PRIVATE_KEY لا يطابق الـendpoint، أو المسار المُوقَّع لا يطابق المطلوب.`,
    };
  }
  if (status === 404) {
    return {
      state: 'failed',
      status,
      message: 'الملف غير موجود على ImageKit (HTTP 404) — المسار المخزَّن في القاعدة لا يقابل ملفاً فعلياً.',
    };
  }
  return { state: 'failed', status, message: `استجابة غير متوقعة من ImageKit (HTTP ${status}).` };
}

/** توقيع مرشّح واحد ثم فتحه — النتيجة كما تُعرض في الواجهة. */
export async function runImageKitSignCheck(candidate: ImageKitSignCandidate): Promise<ImageKitSignCheckResult> {
  const { step: sign, signedUrl } = await requestSignedUrl(candidate.path);
  if (!signedUrl) return { candidate, sign, open: UNKNOWN_STEP };
  const open = await openSignedUrl(signedUrl);
  return { candidate, sign, open };
}
