import { App } from '@capacitor/app';
import { Browser } from '@capacitor/browser';
import { supabase } from '@/lib/supabase';

const handledCodes = new Set<string>();
let listenerHandle: { remove: () => Promise<void> } | null = null;
let inFlight = false;

export function isNativePlatform(): boolean {
  return typeof (window as any)?.Capacitor?.isNativePlatform === 'function'
    && (window as any).Capacitor.isNativePlatform() === true;
}

export interface ParsedOAuthCallback {
  ok: boolean;
  code?: string;
  error?: string;
}

export function parseOAuthCallback(url: string): ParsedOAuthCallback {
  if (typeof url !== 'string') return { ok: false, error: 'invalid_url' };
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { ok: false, error: 'invalid_url' };
  }
  if (parsed.protocol !== 'anisocial:' || parsed.hostname !== 'auth' || parsed.pathname !== '/callback') {
    return { ok: false, error: 'invalid_url' };
  }
  const error = parsed.searchParams.get('error') || parsed.searchParams.get('error_description');
  if (error) return { ok: false, error };
  const code = parsed.searchParams.get('code');
  if (!code) return { ok: false, error: 'missing_code' };
  return { ok: true, code };
}

export async function startNativeGoogleOAuth(): Promise<void> {
  if (!isNativePlatform() || inFlight) return;
  inFlight = true;
  try {
    const { data, error } = await supabase.auth.signInWithOAuth({
      provider: 'google',
      options: {
        redirectTo: 'anisocial://auth/callback',
        skipBrowserRedirect: true,
      },
    });
    if (error) throw error;
    if (data?.url) await Browser.open({ url: data.url });
  } finally {
    // allow new attempt after browser returns / failure
    setTimeout(() => { inFlight = false; }, 0);
  }
}

export async function handleNativeOAuthUrl(url: string): Promise<{ ok: boolean; error?: string }> {
  const parsed = parseOAuthCallback(url);
  if (!parsed.ok || !parsed.code) return { ok: false, error: parsed.error || 'invalid_url' };
  if (handledCodes.has(parsed.code)) return { ok: true };
  handledCodes.add(parsed.code);
  try {
    const { error } = await supabase.auth.exchangeCodeForSession(parsed.code);
    if (error) throw error;
    await Browser.close().catch(() => {});
    return { ok: true };
  } catch (e: any) {
    handledCodes.delete(parsed.code);
    return { ok: false, error: e?.message || 'exchange_failed' };
  }
}

export function registerNativeOAuthListener(): void {
  if (listenerHandle) return;
  App.addListener('appUrlOpen', (event) => {
    void handleNativeOAuthUrl(event.url);
  }).then((handle) => { listenerHandle = handle; }).catch(() => {});
  App.getLaunchUrl().then((result) => {
    if (result?.url) void handleNativeOAuthUrl(result.url);
  }).catch(() => {});
}

export function resetNativeOAuthGuard(): void {
  handledCodes.clear();
}