import { supabase } from "./supabase";

// إعادة الاتصال بقنوات Supabase Realtime تلقائياً عند عودة المستخدم
// للتطبيق بعد تجميد المتصفح (visibilitychange) أو عودة الشبكة (online).
// الفكرة: إعادة تشغيل socket القنوات فتعيد جميع القنوات الاشتراك تلقائياً،
// وبطريقة صامتة دون إظهار أي نافذة خطأ CHANNEL_ERROR.

type ReconnectListener = () => void;

const listeners = new Set<ReconnectListener>();

let bound = false;
let lastAttemptAt = 0;

const MIN_ATTEMPT_INTERVAL_MS = 4000;

function attemptReconnect(): void {
  const now = Date.now();
  if (now - lastAttemptAt < MIN_ATTEMPT_INTERVAL_MS) return;
  lastAttemptAt = now;

  try {
    const realtime = supabase.realtime;
    // لا نستدعي disconnect() قبل connect(): disconnect() يضع عميل Realtime
    // في حالة «disconnecting»، فيفشل connect() المتزامن بعده ويعود دون
    // إعادة اتصال، ويبقى الـsocket ميتاً. connect() وحدها تتجاهل الاتصال
    // القائم وتعيد الاتصال عند الحاجة.
    if (!realtime.isConnected()) realtime.connect();
  } catch {
    /* تجاهل أخطاء إعادة الاتصال الصامتة */
  }

  for (const listener of listeners) {
    try {
      listener();
    } catch {
      /* لا نُظهر أي خطأ للمستخدم هنا */
    }
  }
}

function handleVisibilityChange(): void {
  if (document.visibilityState === "visible") attemptReconnect();
}

function handleOnline(): void {
  attemptReconnect();
}

function bindGlobalListeners(): void {
  if (bound || typeof document === "undefined") return;
  bound = true;
  document.addEventListener("visibilitychange", handleVisibilityChange);
  window.addEventListener("online", handleOnline);
}

export function registerRealtimeReconnect(listener: ReconnectListener): () => void {
  bindGlobalListeners();
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
