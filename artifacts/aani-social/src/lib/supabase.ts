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
const FALLBACK_SUPABASE_URL = "https://whvhxgfdumxzunzsjkll.supabase.co";
const FALLBACK_SUPABASE_ANON_KEY =
  "sb_publishable_uY5fTNffiCtUgKnrTLu6rA_KOoaS18j";

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

export const supabase: SupabaseClient = createClient(
  supabaseUrl,
  supabasePublicKey,
  {
    auth: {
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: true,
    },
  },
);

export { supabaseUrl, supabasePublicKey };
