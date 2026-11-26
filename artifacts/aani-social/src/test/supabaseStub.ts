/*
 * Test-only Supabase stub. It mirrors every export of src/lib/supabase.ts so the
 * browser harness can import it, but it never creates a client and never reaches
 * Supabase or any other network: supabaseConfigured is false, so the app's media
 * and data paths fall back to their unconfigured behaviour, and any accidental
 * call is refused locally instead of going out.
 */
export const supabaseUrl = 'https://supabase.test.invalid';

export const supabasePublicKey = 'test-publishable-key';

export const supabaseConfigured = false;

export const storageBucket = 'media';

export const supabaseUsingFallbackCredentials = false;

const unavailable = () => {
  throw new Error('Supabase is not available in the profile reorder browser tests');
};

export const supabase = {
  auth: {
    getSession: unavailable,
    getUser: unavailable,
    onAuthStateChange: unavailable,
    signOut: unavailable,
  },
  storage: { from: unavailable },
  functions: { invoke: unavailable },
  channel: unavailable,
  removeChannel: unavailable,
  rpc: unavailable,
  from: unavailable,
};

/** Mirrors the real registry hook: nothing is registered outside uploads. */
export function registerUploadedMediaUrl(_path: string, _url: string): void {
  // No uploads happen in browser tests, so the registry stays empty.
}
