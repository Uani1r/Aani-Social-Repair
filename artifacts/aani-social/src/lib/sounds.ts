// نظام الأصوات بنمط TikTok: نافذة تفاصيل الصوت + مسار «استخدام هذا الصوت».
// التواصل بين المشغلات (ReelSlide / FeedPostCard) وShell يتم عبر أحداث النافذة
// حتى تعمل الميزة من أي شاشة دون تمرير خصائص عبر كل الطبقات.

export type OpenSoundDetail = {
  soundId: string;
  title?: string | null;
  creatorName?: string | null;
  /** رابط الفيديو الأصلي لمعاينة الصوت (اختياري — تُجلبه نافذة الصوت من قاعدة البيانات) */
  sourceVideoUrl?: string | null;
};

export type SoundTrimRange = { start: number; end: number };

export type UseSoundDetail = {
  soundId: string;
  title?: string | null;
  sourceVideoUrl?: string | null;
  /** زمني اقتصاص الصوت المختار (بالثواني) — يُحفظ مع المنشور في sound_trim_start/sound_trim_end */
  soundTrim?: SoundTrimRange | null;
  /** مصدر الطلب: 'picker' = مكتبة الأصوات داخل مسار النشر، غير ذلك = شريط الصوت في المنشور */
  source?: 'picker' | 'post';
};

export const OPEN_SOUND_EVENT = 'aani:open-sound';
export const USE_SOUND_EVENT = 'aani:use-sound';
export const OPEN_SOUND_PICKER_EVENT = 'aani:open-sound-picker';

/** فتح صفحة/قائمة الصوت: تُعرض كل الفيديوهات المرتبطة بنفس sound_id */
export function openSoundDetail(detail: OpenSoundDetail): void {
  window.dispatchEvent(new CustomEvent<OpenSoundDetail>(OPEN_SOUND_EVENT, { detail }));
}

/** استخدام هذا الصوت: يُمرَّر sound_id إلى مسار إنشاء فيديو جديد */
export function useExistingSound(detail: UseSoundDetail): void {
  window.dispatchEvent(new CustomEvent<UseSoundDetail>(USE_SOUND_EVENT, { detail }));
}

/** فتح مكتبة أصوات التطبيق (public.sounds) لاختيار صوت للمنشور الجاري إنشاؤه */
export function openSoundPicker(): void {
  window.dispatchEvent(new CustomEvent(OPEN_SOUND_PICKER_EVENT));
}

/** الاسم المعروض للصوت الأصلي المرتبط بمنشور */
export function defaultSoundTitle(creatorName?: string | null): string {
  return `الصوت الأصلي - ${(creatorName || '').trim() || 'المستخدم'}`;
}

/** الرابط الأساسي للفيديو بدون ترميز التعديل (#t= / #crop=...) — يطابق sounds.source_video_url */
export function baseVideoUrl(url: string): string {
  return url.replace(/#.*$/, '');
}
