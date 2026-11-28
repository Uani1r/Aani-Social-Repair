import { useEffect, useMemo, useState } from 'react';
import { BellRing, Share } from 'lucide-react';

import {
  PUSH_MESSAGES,
  isFirebaseMessagingConfigured,
  readPushEnvironment,
  registerPushNotifications,
  type PushEnvironment,
} from '@/lib/pushNotifications';

type PushStatus = 'idle' | 'loading' | 'enabled' | 'unavailable' | 'install' | 'error';

/**
 * بطاقة إشعارات هذا الجهاز.
 *
 * القاعدة الحاكمة: لا طلب إذن على iPhone/iPad قبل تثبيت التطبيق على الشاشة
 * الرئيسية — يُعرض شرح الإضافة بدلاً من نافذة الإذن. وبعد التثبيت (standalone)
 * يُسمح بالمتابعة وفق دعم إصدار iOS. ولا تُعرض رسالة نجاح قبل أن يعيد الخادم
 * صف الجهاز المسجّل بعد الحصول على رمز FCM.
 */
export default function PushNotificationsControl({ currentUserId }: { currentUserId: string }) {
  // تُخفى البطاقة تماماً من شاشة الإشعارات طالما لم يُربط Firebase بنجاح.
  const firebaseReady = isFirebaseMessagingConfigured();
  const environment = useMemo<PushEnvironment>(() => readPushEnvironment(), []);
  const [status, setStatus] = useState<PushStatus>('idle');
  const [message, setMessage] = useState('');

  useEffect(() => {
    if (!firebaseReady) {
      setStatus('unavailable');
      setMessage('');
      return;
    }

    // iOS بلا تثبيت: شرح الإضافة إلى الشاشة الرئيسية، وبلا أي طلب إذن.
    if (environment.status === 'ios-install-required') {
      setStatus('install');
      setMessage(environment.message);
      return;
    }

    if (
      environment.status === 'unsupported'
      || environment.status === 'insecure'
      || environment.status === 'denied'
    ) {
      setStatus('unavailable');
      setMessage(environment.message);
      return;
    }

    if (environment.status === 'needs-permission') {
      setStatus('idle');
      setMessage(environment.message);
      return;
    }

    // الإذن ممنوح مسبقاً: تسجيل الجهاز بلا طلب إذن، للتأكد من صف على الخادم.
    let active = true;
    setStatus('loading');
    void registerPushNotifications(currentUserId, false).then(result => {
      if (!active) return;
      setStatus(result.ok ? 'enabled' : 'error');
      setMessage(result.message);
    });
    return () => { active = false; };
  }, [currentUserId, firebaseReady, environment]);

  const enableNotifications = async () => {
    setStatus('loading');
    setMessage('جارٍ تفعيل الإشعارات لهذا الجهاز…');
    const result = await registerPushNotifications(currentUserId, true);
    setStatus(result.ok ? 'enabled' : 'error');
    setMessage(result.message);
  };

  if (!firebaseReady) return null;

  const installRequired = status === 'install';
  // لا زر حين لا يُسمح بطلب الإذن (iPhone بلا تثبيت، أو محظور/غير مدعوم)،
  // ويبقى الزر لإعادة المحاولة بعد فشل الحفظ وحدها.
  const canRequest = !installRequired
    && environment.status !== 'denied'
    && environment.status !== 'unsupported'
    && environment.status !== 'insecure'
    && (status === 'idle' || status === 'error');
  const description = message
    || (installRequired
      ? PUSH_MESSAGES.iosInstall
      : 'استقبل الرسائل والتفاعلات والمكالمات حتى عند إغلاق التطبيق.');

  return (
    <section className="rounded-2xl border border-[#c98a66]/20 bg-[#141414] px-4 py-3">
      <div className="flex items-center gap-3">
        <span className="grid h-10 w-10 shrink-0 place-items-center rounded-full bg-[#c98a66]/10 text-[#c98a66]">
          {installRequired ? <Share size={19} /> : <BellRing size={19} />}
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-bold text-[#f0f0f0]">
            {installRequired ? 'تثبيت آني لإشعارات iPhone' : 'إشعارات هذا الجهاز'}
          </p>
          <p role="status" className="mt-1 text-xs leading-5 text-[#9b9b9b]">{description}</p>
        </div>
        {canRequest && (
          <button
            type="button"
            onClick={() => void enableNotifications()}
            className="shrink-0 rounded-xl bg-[#c98a66] px-3 py-2 text-xs font-bold text-black"
          >
            تفعيل
          </button>
        )}
      </div>
      {installRequired && (
        <ol className="mt-3 space-y-1 border-t border-white/[0.06] pt-3 text-xs leading-5 text-[#9b9b9b]">
          <li>١. افتح آني في Safari على iPhone أو iPad.</li>
          <li>٢. اضغط زر المشاركة (مربع مع سهم لأعلى).</li>
          <li>٣. اختر «إضافة إلى الشاشة الرئيسية» ثم «إضافة».</li>
          <li>٤. افتح آني من الشاشة الرئيسية وفعّل الإشعارات من هنا.</li>
        </ol>
      )}
    </section>
  );
}
