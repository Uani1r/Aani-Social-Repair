declare module 'https://www.gstatic.com/firebasejs/13.0.0/firebase-app.js' {
  export function getApps(): Array<{ name: string }>;
  export function getApp(): unknown;
  export function initializeApp(options: Record<string, string>): unknown;
}

declare module 'https://www.gstatic.com/firebasejs/13.0.0/firebase-messaging.js' {
  export function isSupported(): Promise<boolean>;
  export function getMessaging(app: unknown): unknown;
  export function getToken(
    messaging: unknown,
    options: { vapidKey: string; serviceWorkerRegistration: ServiceWorkerRegistration },
  ): Promise<string>;
}
