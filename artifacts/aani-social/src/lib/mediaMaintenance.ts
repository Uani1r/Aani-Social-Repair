// صيانة دورية للموسائط وقاعدة البيانات ضمن حدود الباقات المجانية:
// - مرة واحدة كل 24 ساعة لكل مستخدم مسجل الدخول:
//   1) RPC قاعدة البيانات يحذف القصص المنتهية (بعد مهلة يومين) وأرشفة مشاهداتها والإشعارات الأقدم من 30 يوماً.
//   2) نقطة نهاية الخادم تحذف ملفات ImageKit للقصص المنتهية غير المستخدمة في أبرز القصص أو الأصوات النشطة.
// - عند حذف منشور أو ستوري يُطلب من الخادم حذف ملفات الوسائط المقابلة قبل حذف الصفوف،
//   بشرط التحقق من أنها غير مستخدمة في أبرز القصص (غلاف أو عنصر) أو مكتبة الأصوات النشطة.

import { supabase } from '@/lib/supabase';

const CLEANUP_INTERVAL_MS = 24 * 60 * 60 * 1000;
const LAST_RUN_KEY = 'aani_media_cleanup_last_run';

/** فحص صحي يومي: تنظيف قاعدة البيانات + ملفات الوسائط المنتهية. */
export function runMediaMaintenanceOncePerDay(): void {
  try {
    const last = Number(localStorage.getItem(LAST_RUN_KEY) || 0);
    if (Number.isFinite(last) && Date.now() - last < CLEANUP_INTERVAL_MS) return;
    localStorage.setItem(LAST_RUN_KEY, String(Date.now()));
  } catch {
    return; // localStorage غير متاح — لا شيء يتعطل
  }

  void (async () => {
    try {
      const { error } = await supabase.rpc('aani_cleanup_expired_media_records');
      if (error) console.warn('[maintenance] تعذر تنفيذ تنظيف قاعدة البيانات:', error);
    } catch (error) {
      console.warn('[maintenance] تعذر تنفيذ تنظيف قاعدة البيانات:', error);
    }

    try {
      const { data } = await supabase.auth.getSession();
      const token = data.session?.access_token;
      if (!token) return;
      const response = await fetch('/api/media/purge-expired', {
        method: 'POST',
        headers: { authorization: `Bearer ${token}` },
      });
      // 503 = الخادم غير مهيأ بعد — لا حاجة للإنذار
      if (!response.ok && response.status !== 503) {
        console.warn('[maintenance] تعذر تنفيذ حذف ملفات الوسائط المنتهية:', response.status);
      }
    } catch (error) {
      console.warn('[maintenance] تعذر الاتصال بخدمة حذف الوسائط المنتهية:', error);
    }
  })();
}

/**
 طلب حذف ملفات الوسائط من ImageKit قبل حذف صف المنشور/الستوري.
 يتحقق الخادم من الملكية ومن عدم استخدام الوسائط في أبرز القصص أو الأصوات النشطة قبل الحذف.
 */
export async function requestMediaDeletion(kind: 'post' | 'story', id: string): Promise<void> {
  try {
    const { data } = await supabase.auth.getSession();
    const token = data.session?.access_token;
    if (!token) return;

    const response = await fetch('/api/media/imagekit-delete', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({ kind, id }),
    });
    if (!response.ok) {
      console.warn('[maintenance] تعذر حذف ملفات الوسائط المقابلة:', response.status);
    }
  } catch (error) {
    console.warn('[maintenance] تعذر طلب حذف ملفات الوسائط:', error);
  }
}
