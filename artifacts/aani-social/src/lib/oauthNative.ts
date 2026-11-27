import { App } from '@capacitor/app';
import { Browser } from '@capacitor/browser';
import { supabase } from '@/lib/supabase';

let listenerHandle: { remove: () => Promise<void> } | null = null;
let handledCode: string | null = null;

export function isNativePlatform(): boolean {
  return typeof (window as any)?.Capacitor?.isNativePlatform === 'function'
    && (window as any).Capacitor.isNativePlatform() === true;
}

export async function startNativeGoogleOAuth(): Promise<void> {
  if (!isNativePlatform()) return;
  const { data, error } = await supabase.auth.signInWithOAuth({
    provider: 'google',
    options: {
      redirectTo: 'anisocial://auth/callback',
      skipBrowserRedirect: true,
    },
  });
  if (error) throw error;
  if (data?.url) await Browser.open({ url: data.url });
  // close browser after return handled elsewhere
}

function parseParams(url: string): URLSearchParams {
  const qIndex = url.indexOf('?');
  const hashIndex = url.indexOf('#');
  const query = qIndex >= 0 ? url.slice(qIndex + 1, hashIndex >= 0 ? hashIndex : undefined) : '';
  return new URLSearchParams(query);
}

export async function handleNativeOAuthUrl(url: string): Promise<{ ok: boolean; error?: string }> {
  if (!url || !url.startsWith('anisocial://auth/callback')) return { ok: false, error: 'invalid_url' };
  const params = parseParams(url);
  const code = params.get('code');
  const error = params.get('error') || params.get('error_description');
  if (error) return { ok: false, error };
  if (!code) return { ok: false, error: 'missing_code' };
  if (handledCode === code) return { ok: true }; // already exchanged
  handledCode = code;
  try {
    const { error: exError } = await supabase.auth.exchangeCodeForSession(code);
    if (exError) throw exError;
    await Browser.close().catch(() => {});
    return { ok: true };
  } catch (e: any) {
    handledCode = null;
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
  handledCode = null;
}