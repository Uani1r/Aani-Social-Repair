/**
 * الوساط الافتراضية المجهزة مسبقاً (Pre-Warmed Default Sounds Pool):
 * قائمة مصغرة (أعلى 3 أصوات عشوائية) تُجلب مرة واحدة فور فتح واجهة إنشاء
 * المنشورات وتُخزن في الذاكرة مع تسخين كاش الشبكة لروابطها (HTTP Range/206)،
 * فيبدأ التشغيل لحظة اختيار الصورة (أقل من 50ms) داخل سياق إيماءة المستخدم.
 */
import { supabase, supabaseConfigured } from '@/lib/supabase';
import { warmAudioCache } from '@/lib/instantAudio';

export type DefaultSound = {
  id: string;
  title: string;
  source_video_url: string | null;
};

const POOL_SIZE = 3;
let pool: DefaultSound[] = [];
let warming = false;
let warmed = false;

/** جلب وتسخين الوساط الافتراضية (تُستدعى فور فتح واجهة النشر — آمنة للتكرار) */
export async function warmDefaultSounds(): Promise<void> {
  if (!supabaseConfigured || warmed || warming) return;
  warming = true;
  try {
    let rows: DefaultSound[] = [];
    // ترتيب عشوائي في SQL (ORDER BY random()) عبر دالة ترحيل 20270112000000
    const randomized = await supabase.rpc('random_trending_sounds', { pool_size: POOL_SIZE });
    if (!randomized.error && Array.isArray(randomized.data) && randomized.data.length > 0) {
      rows = randomized.data as DefaultSound[];
    } else {
      // الاحتياط: بلا دالة الترتيب العشوائي بعد → استعلام عادي + خلط محلي
      const { data, error } = await supabase
        .from('sounds')
        .select('id, title, source_video_url')
        .order('created_at', { ascending: false })
        .limit(10);
      if (error) return;
      const candidates = (data || []) as DefaultSound[];
      for (let index = candidates.length - 1; index > 0; index--) {
        const swap = Math.floor(Math.random() * (index + 1));
        [candidates[index], candidates[swap]] = [candidates[swap], candidates[index]];
      }
      rows = candidates.slice(0, POOL_SIZE);
    }
    pool = rows.filter(sound => typeof sound?.id === 'string');
    pool.forEach(sound => { if (sound.source_video_url) warmAudioCache(sound.source_video_url); });
    warmed = pool.length > 0;
  } catch {
    /* التسخين اختياري — الفشل يعيد المسار الاحتياطي غير المتزامن */
  } finally {
    warming = false;
  }
}

/**
 * اختيار صوت من الوساط المجهزة مسبقاً (عشوائي مع استبعاد آخر اقتراح
 * لمنع تكرار الصوت في محاولتين متتاليتين). يعيد null إن لم توجد أوساط بعد.
 */
export function pickDefaultSound(excludeId?: string | null): DefaultSound | null {
  const usable = pool.filter(sound => typeof sound.source_video_url === 'string' && Boolean(sound.source_video_url));
  if (usable.length === 0) return null;
  const fresh = excludeId ? usable.filter(sound => sound.id !== excludeId) : usable;
  const candidates = fresh.length > 0 ? fresh : usable;
  return candidates[Math.floor(Math.random() * candidates.length)];
}
