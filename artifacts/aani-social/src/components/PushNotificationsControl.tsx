import { useEffect, useState } from 'react';
import { BellRing } from 'lucide-react';

import { isFirebaseMessagingConfigured, registerPushNotifications } from '@/lib/pushNotifications';

type PushStatus = 'idle' | 'loading' | 'enabled' | 'unavailable' | 'error';

export default function PushNotificationsControl({ currentUserId }: { currentUserId: string }) {
  const [status, setStatus] = useState<PushStatus>('idle');
  const [message, setMessage] = useState('');

  useEffect(() => {
    if (!isFirebaseMessagingConfigured()) {
      setStatus('unavailable');
      setMessage('إعداد Firebase غير مكتمل لهذا التطبيق.');
      return;
    }
    if (typeof Notification === 'undefined') {
      setStatus('unavailable');
      setMessage('هذا المتصفح لا يدعم إشعارات الويب.');
      return;
    }
    if (Notification.permission === 'denied') {
      setStatus('unavailable');
      setMessage('الإشعارات محظورة من إعدادات المتصفح.');
      return;
    }
    if (Notification.permission !== 'granted') return;

    let active = true;
    setStatus('loading');
    void registerPushNotifications(currentUserId, false).then(result => {
      if (!active) return;
      setStatus(result.ok ? 'enabled' : 'error');
      setMessage(result.message);
    });
    return () => { active = false; };
  }, [currentUserId]);

  const enableNotifications = async () => {
    setStatus('loading');
    setMessage('جارٍ تفعيل الإشعارات لهذا الجهاز…');
    const result = await registerPushNotifications(currentUserId, true);
    setStatus(result.ok ? 'enabled' : 'error');
    setMessage(result.message);
  };

  return (
    <section className="rounded-2xl border border-[#c98a66]/20 bg-[#141414] px-4 py-3">
      <div className="flex items-center gap-3">
        <span className="grid h-10 w-10 shrink-0 place-items-center rounded-full bg-[#c98a66]/10 text-[#c98a66]">
          <BellRing size={19} />
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-bold text-[#f0f0f0]">إشعارات هذا الجهاز</p>
          <p role="status" className="mt-1 text-xs leading-5 text-[#9b9b9b]">
            {message || 'استقبل الرسائل والتفاعلات والمكالمات حتى عند إغلاق التطبيق.'}
          </p>
        </div>
        {status !== 'enabled' && (
          <button
            type="button"
            onClick={() => void enableNotifications()}
            disabled={status === 'loading' || status === 'unavailable'}
            className="shrink-0 rounded-xl bg-[#c98a66] px-3 py-2 text-xs font-bold text-black disabled:opacity-50"
          >
            {status === 'loading' ? 'جارٍ التفعيل…' : 'تفعيل'}
          </button>
        )}
      </div>
    </section>
  );
}
