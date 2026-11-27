import { App } from '@capacitor/app';
import { Browser } from '@capacitor/browser';
import { supabase } from '@/lib/supabase';

let handled = false;
let listenerRegistered = false;

export function isNativePlatform(): boolean {
  return typeof (window as any)?.Capacitor?.isNativePlatform === 'function'
    && (window as any).Capacitor.isNativePlatform();
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
}

async function handleUrl(url: string): Promise<void> {
  if (handled) return;
  if (!url || !url.startsWith('anisocial://auth/callback')) return;
  handled = true;
  try {
    await supabase.auth.exchangeCodeForSession(url);
  } catch (e) {
    handled = false;
    throw e;
  }
}

export function registerNativeOAuthListener(): void {
  if (listenerRegistered) return;
  listenerRegistered = true;
  App.addListener('appUrlOpen', (event) => {
    void handleUrl(event.url);
  });
  App.getLaunchUrl().then((result) => {
    if (result?.url) void handleUrl(result.url);
  }).catch(() => {});
}

export function resetNativeOAuthGuard(): void {
  handled = false;
}