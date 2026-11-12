import { createClient, type SupabaseClient } from "@supabase/supabase-js";

/**
 * Hard-coded public credentials.
 *
 * These are PUBLIC values (the Supabase URL and the publishable/anon key) that Vite
 * already inlines into the client bundle. They are kept here as a last-resort
 * fallback so the app still connects to the backend when environment variables are
 * missing at build time (e.g. a deploy that skipped `.env`).
 *
 * Never place a service_role key or any secret in this file.
 */
const FALLBACK_SUPABASE_URL = "https://auqqqwfjxrxizlmeweka.supabase.co";
const FALLBACK_SUPABASE_ANON_KEY =
  "sb_publishable_RD_YttgesZJraGb7dvuArQ_ggxUCfmt";

const FALLBACK_STORAGE_BUCKET = "aani-media";

function readEnv(): Record<string, string | undefined> {
  // `import.meta.env` can be undefined in non-Vite execution contexts
  // (plain node scripts, some test runners, older bundlers). Guard it so the
  // module never throws at import time.
  try {
    const env = (import.meta as { env?: Record<string, string | undefined> })
      .env;
    if (env && typeof env === "object") return env;
  } catch {
    /* ignore — fall through to hardcoded credentials */
  }
  return {};
}

const env = readEnv();

const fromEnv = (value: string | undefined): string =>
  typeof value === "string" ? value.trim() : "";

const supabaseUrl = fromEnv(env.VITE_SUPABASE_URL) || FALLBACK_SUPABASE_URL;

const supabasePublicKey =
  fromEnv(env.VITE_SUPABASE_PUBLISHABLE_KEY) ||
  fromEnv(env.VITE_SUPABASE_ANON_KEY) ||
  FALLBACK_SUPABASE_ANON_KEY;

export const supabaseConfigured = Boolean(supabaseUrl && supabasePublicKey);

export const storageBucket =
  fromEnv(env.VITE_SUPABASE_STORAGE_BUCKET) || FALLBACK_STORAGE_BUCKET;

/** True when the credentials came from the hardcoded fallback. */
export const supabaseUsingFallbackCredentials =
  supabaseUrl === FALLBACK_SUPABASE_URL &&
  supabasePublicKey === FALLBACK_SUPABASE_ANON_KEY;

if (supabaseUsingFallbackCredentials) {
  console.warn(
    "[supabase] Using hard-coded fallback credentials. Set VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY to override.",
  );
}

if (!/^https:\/\/[a-zA-Z0-9-]+\.supabase\.co\/?$/.test(supabaseUrl)) {
  console.error("[supabase] VITE_SUPABASE_URL is not a valid Supabase project URL.", supabaseUrl);
}

function createSupabaseClient(url: string, key: string): SupabaseClient {
  return createClient(url, key, {
    auth: {
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: true,
    },
  });
}

// محصّن ضد أي فشل عند الإقلاع: إن رفض createClient القيم الحالية
// (رابط أو مفتاح غير صالح في Secrets مثلًا) يعاد الإنشاء بالقيم الاحتياطية
// العامة بدل أن ينهار التحميل ويترك التطبيق شاشة بيضاء.
export let supabase: SupabaseClient;
try {
  supabase = createSupabaseClient(supabaseUrl, supabasePublicKey);
} catch (createClientError) {
  console.error(
    "[supabase] تعذر إنشاء عميل Supabase بالإعدادات الحالية — إعادة المحاولة بقيم الاحتياط العام.",
    createClientError,
  );
  supabase = createSupabaseClient(FALLBACK_SUPABASE_URL, FALLBACK_SUPABASE_ANON_KEY);
}

export { supabaseUrl, supabasePublicKey };

// ===== ImageKit: سجل روابط الملفات المرفوعة مباشرة =====
// عند الرفع المباشر إلى ImageKit (بدل Supabase Storage) يُسجَّل هنا الرابط
// العام الناتج مقابل مسار الرفع، فيعيد getPublicUrl الرابط الحقيقي للملف
// المرفوع حديثاً بدل تكوين رابط Supabase غير موجود. الصفوف القديمة في
// قاعدة البيانات (مسارات Supabase) تُحلَّ كما كانت عبر التخزين.
const uploadedMediaUrlRegistry = new Map<string, string>();

function normalizeMediaPathKey(path: string): string {
  return (path || '').split('#', 1)[0].replace(/^\/+/, '');
}

export function registerUploadedMediaUrl(path: string, url: string): void {
  const key = normalizeMediaPathKey(path);
  if (!key || !url) return;
  uploadedMediaUrlRegistry.set(key, url);
}

type StorageBucketApiLike = ReturnType<typeof supabase.storage.from>;

// محمي داخل try/catch: أي فشل في هذه الرقعة لا يجعل التطبيق شاشة بيضاء —
// يبقى التخزين الأصلي يعمل كما كان.
try {
  const originalStorageFrom = supabase.storage.from.bind(supabase.storage);

  (supabase.storage as unknown as { from: (bucket: string) => StorageBucketApiLike }).from = (
    bucket: string,
  ): StorageBucketApiLike => {
    const bucketApi = originalStorageFrom(bucket);
    const originalGetPublicUrl = bucketApi.getPublicUrl.bind(bucketApi);
    (bucketApi as unknown as { getPublicUrl: unknown }).getPublicUrl = (
      path: string,
      options?: Parameters<typeof originalGetPublicUrl>[1],
    ): ReturnType<typeof originalGetPublicUrl> => {
      const registered = uploadedMediaUrlRegistry.get(normalizeMediaPathKey(path));
      if (registered) {
        return { data: { publicUrl: registered }, error: null } as ReturnType<typeof originalGetPublicUrl>;
      }
      return originalGetPublicUrl(path, options);
    };
    return bucketApi;
  };
} catch (storagePatchError) {
  console.warn('[supabase] تعذر تفعيل سجل روابط ImageKit — التخزين الأصلي يعمل كما هو', storagePatchError);
}
