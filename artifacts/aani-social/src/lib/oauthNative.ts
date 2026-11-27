/**
 * oauthNative.ts
 * ربط Google OAuth الأصلي بـCapacitor (App/Browser) وSupabase Auth.
 *
 * المنطق كله في `oauthNativeCore.ts` (نقي وقابل للاختبار بمحاكاة كاملة)؛ هذا
 * الملف يمرّر الأدوات الحقيقية فقط: فتح المتصفح وإغلاقه، وحدث إغلاقه بيد
 * المستخدم (`browserFinished` — الحدث المدعوم في نسخة @capacitor/browser
 * المثبتة، ولا يوجد حدث «إلغاء» غيره)، ومستمع رابط التطبيق، ورابط التشغيل
 * البارد، وتبادل الرمز عبر Supabase.
 */

import { App } from '@capacitor/app';
import { Browser } from '@capacitor/browser';
import { supabase } from '@/lib/supabase';
import {
  NATIVE_OAUTH_REDIRECT_URL,
  isNativePlatform as readNativePlatform,
} from '@/lib/oauthRedirect';
import {
  createNativeOAuthGate,
  createNativeOAuthUrlListener,
  type ListenerHandle,
  type NativeOAuthResult,
  type NativeOAuthStartResult,
} from '@/lib/oauthNativeCore';

export {
  describeNativeOAuthError,
  nativeOAuthDecision,
  parseOAuthCallback,
} from '@/lib/oauthNativeCore';
export type {
  NativeOAuthDecision,
  NativeOAuthResult,
  NativeOAuthStartResult,
  ParsedOAuthCallback,
} from '@/lib/oauthNativeCore';

export function isNativePlatform(): boolean {
  return readNativePlatform();
}

const gate = createNativeOAuthGate({
  async signInWithOAuth() {
    const { data, error } = await supabase.auth.signInWithOAuth({
      provider: 'google',
      options: {
        redirectTo: NATIVE_OAUTH_REDIRECT_URL,
        skipBrowserRedirect: true,
      },
    });
    const url = (data as { url?: string | null } | null)?.url ?? null;
    return { url, error: error ?? null };
  },
  async exchangeCodeForSession(code) {
    const { data, error } = await supabase.auth.exchangeCodeForSession(code);
    const session = (data as { session?: unknown } | null)?.session ?? null;
    return { session, error: error ?? null };
  },
  openBrowser: url => Browser.open({ url }),
  closeBrowser: () => Browser.close(),
  async onBrowserFinished(handler): Promise<ListenerHandle> {
    const handle = await Browser.addListener('browserFinished', () => handler());
    return { remove: () => handle.remove() };
  },
});

export function onNativeOAuthResult(handler: (result: NativeOAuthResult) => void): () => void {
  return gate.subscribe(handler);
}

export function startNativeGoogleOAuth(): Promise<NativeOAuthStartResult> {
  return gate.start();
}

export function handleNativeOAuthUrl(url: string): Promise<NativeOAuthResult> {
  return gate.handleUrl(url);
}

export async function resetNativeOAuthGuard(): Promise<void> {
  await gate.reset();
}

const urlListener = createNativeOAuthUrlListener({
  addAppUrlListener: async handler => {
    const handle = await App.addListener('appUrlOpen', event => handler(event.url));
    return { remove: () => handle.remove() };
  },
  getLaunchUrl: async () => {
    const launch = await App.getLaunchUrl();
    return typeof launch?.url === 'string' && launch.url ? launch.url : null;
  },
  handleUrl: url => gate.handleUrl(url),
});

/** تسجيل مستمع روابط التطبيق مرة واحدة (التسجيل المتزامن المتكرر يعيد نفسه). */
export function registerNativeOAuthListener(): Promise<void> {
  return urlListener.register();
}

/** إزالة المستمع: تحرير كامل، والتسجيل يعمل من جديد عند الحاجة. */
export function unregisterNativeOAuthListener(): Promise<void> {
  return urlListener.unregister();
}
