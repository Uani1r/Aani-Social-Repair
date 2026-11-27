export const NATIVE_OAUTH_REDIRECT_URL = 'anisocial://auth/callback';

export function isNativePlatform(): boolean {
  if (typeof window === 'undefined') return false;
  const cap = (window as unknown as { Capacitor?: { isNativePlatform?: () => boolean } }).Capacitor;
  return typeof cap?.isNativePlatform === 'function' && cap.isNativePlatform() === true;
}

export function getOAuthRedirectUrl(): string {
  if (isNativePlatform()) return NATIVE_OAUTH_REDIRECT_URL;
  if (typeof window !== 'undefined' && window.location?.origin) return window.location.origin;
  return '';
}

export function isAppleOAuthEnabled(): boolean {
  try {
    const env = (import.meta as { env?: Record<string, string | undefined> }).env;
    const value = env?.VITE_APPLE_OAUTH_ENABLED;
    return String(value || '').trim().toLowerCase() === 'true';
  } catch {
    return false;
  }
}