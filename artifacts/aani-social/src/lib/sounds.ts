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
  /** رابط معاينة صوتي خفيف إن كان متاحاً */
  previewUrl?: string | null;
  /** زمني اقتصاص الصوت المختار (بالثواني) — يُحفظ مع المنشور في sound_trim_start/sound_trim_end */
  soundTrim?: SoundTrimRange | null;
  /** اسم صاحب الصوت الأصلي (يُستخدم في الخلفية التلقائية المولدة) */
  creatorName?: string | null;
  /** مصدر الطلب: 'picker' = مسار النشر، 'post' = شريط الصوت في المنشور، 'story' = القصة */
  source?: 'picker' | 'post' | 'story';
};

/** صوت القصة المختار من مكتبة الأصوات (يُحفظ مع القصة في sound_id وزمني القص) */
export type StorySound = {
  soundId: string;
  title: string;
  sourceVideoUrl: string | null;
  soundTrim: SoundTrimRange | null;
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

/** وجهة مكتبة الأصوات القادمة: 'post' = مسار النشر (الافتراضي)، 'story' = القصة */
let soundPickerTarget: 'post' | 'story' = 'post';

/** فتح مكتبة أصوات التطبيق (public.sounds) مع تحديد وجهة الاختيار */
export function openSoundPicker(target: 'post' | 'story' = 'post'): void {
  soundPickerTarget = target;
  window.dispatchEvent(new CustomEvent(OPEN_SOUND_PICKER_EVENT));
}

/** قراءة وجهة الاختيار عند تطبيق الصوت (تُستهلك مرة واحدة ثم تعود لـ 'post') */
export function consumeSoundPickerTarget(): 'post' | 'story' {
  const target = soundPickerTarget;
  soundPickerTarget = 'post';
  return target;
}

/** الاسم المعروض للصوت الأصلي المرتبط بمنشور */
export function defaultSoundTitle(creatorName?: string | null): string {
  return `الصوت الأصلي - ${(creatorName || '').trim() || 'المستخدم'}`;
}

/** الرابط الأساسي للفيديو بدون ترميز التعديل (#t= / #crop=...) ومعاملات العرض (?tr=...) — يطابق sounds.source_video_url */
export function baseVideoUrl(url: string): string {
  return url.replace(/[?#].*$/, '');
}
