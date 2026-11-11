/**
 * الوساط الافتراضية المجهزة مسبقاً (Pre-Warmed Default Sounds Pool):
 * قائمة صغيرة من بيانات الأصوات تُخزن في الذاكرة وsessionStorage، حتى يبدأ
 * رابط الصوت المتاح محلياً في نفس إيماءة اختيار الصورة بلا انتظار لطلب الشبكة.
 * تُحدّث القائمة عشوائياً بالخلفية وتُستبعد الأصوات المقترحة مؤخراً.
 * وتختلف الأوساط المتاحة بين الدخول والخروج فلا يتكرر الصوت المقترح.
 */
import { supabase, supabaseConfigured } from '@/lib/supabase';

export type DefaultSound = {
  id: string;
  title: string;
  source_video_url: string | null;
};

const POOL_SIZE = 3;
const POOL_STORAGE_KEY = 'aani:default-sound-pool';

function readCachedPool(): DefaultSound[] {
  if (typeof window === 'undefined') return [];
  try {
    const value = window.sessionStorage.getItem(POOL_STORAGE_KEY);
    const parsed = value ? JSON.parse(value) as unknown : null;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((item): item is DefaultSound => Boolean(
      item
      && typeof item === 'object'
      && typeof (item as DefaultSound).id === 'string'
      && typeof (item as DefaultSound).title === 'string'
      && (typeof (item as DefaultSound).source_video_url === 'string' || (item as DefaultSound).source_video_url === null),
    ));
  } catch {
    return [];
  }
}

let pool: DefaultSound[] = readCachedPool();
let warming = false;

/** جلب وتسخين الوساط الافتراضية — تُستدعى فور كل فتح لواجهة النشر (جلب جديد في كل مرة) */
export async function warmDefaultSounds(): Promise<void> {
  if (!supabaseConfigured || warming) return;
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
    try {
      window.sessionStorage.setItem(POOL_STORAGE_KEY, JSON.stringify(pool));
    } catch {
      /* the in-memory pool remains available if session storage is disabled */
    }
  } catch {
    /* التسخين اختياري — الفشل يعيد المسار الاحتياطي غير المتزامن */
  } finally {
    warming = false;
  }
}

/**
 * اختيار صوت من الوساط المجهزة مسبقاً: عشوائي مع استبعاد كل الأصوات
 * المقترحة مؤخراً (سجل الجلسة) لمنع التكرار نهائياً بين المتتاليات.
 * يعيد null إن لم توجد أوساط بعد أو لم ينجح الاستبعاد مع القائمة كاملة.
 */
export function pickDefaultSound(excludeIds?: string[] | null): DefaultSound | null {
  const usable = pool.filter(sound => typeof sound.source_video_url === 'string' && Boolean(sound.source_video_url));
  if (usable.length === 0) return null;
  const excluded = excludeIds && excludeIds.length > 0 ? excludeIds : [];
  const fresh = excluded.length > 0 ? usable.filter(sound => !excluded.includes(sound.id)) : usable;
  const candidates = fresh.length > 0 ? fresh : usable;
  return candidates[Math.floor(Math.random() * candidates.length)];
}
