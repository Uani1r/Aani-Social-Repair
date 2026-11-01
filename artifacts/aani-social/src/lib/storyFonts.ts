// مكتبة خطوط وألوان وحركات نص القصة (شريط أدوات محرر النص)

export type StoryFontTab = 'ar' | 'en';
export type StoryTextAlign = 'right' | 'center' | 'left';
export type StoryTextAnimation =
  | 'none'
  | 'typewriter'
  | 'pop'
  | 'slide-up'
  | 'slide-down'
  | 'slide-right'
  | 'slide-left'
  | 'bounce'
  | 'glow';

export interface StoryFontOption {
  family: string;
  label: string;
}

// خطوط عربية: رسمية + نسخ ورقعة + كوفية + حركية + خط الآيفون
export const STORY_FONTS_AR: StoryFontOption[] = [
  { family: 'Cairo', label: 'القاهرة' },
  { family: 'Tajawal', label: 'تجوال' },
  { family: 'Almarai', label: 'المراعي' },
  { family: 'Amiri', label: 'أميري' },
  { family: 'Aref Ruqaa', label: 'رقعة' },
  { family: 'Aref Ruqaa Ink', label: 'رقعة حبر' },
  { family: 'Reem Kufi', label: 'ريم كوفي' },
  { family: 'Noto Kufi Arabic', label: 'كوفي' },
  { family: 'Noto Naskh Arabic', label: 'نسخ' },
  { family: 'Noto Sans Arabic', label: 'نسخ حديث' },
  { family: 'Scheherazade New', label: 'شهرزاد' },
  { family: 'Lateef', label: 'لطيف' },
  { family: 'El Messiri', label: 'المسيري' },
  { family: 'Changa', label: 'تشانغا' },
  { family: 'Mada', label: 'مدى' },
  { family: 'Markazi Text', label: 'مركزي' },
  { family: 'Harmattan', label: 'هرمتان' },
  { family: 'Baloo Bhaijaan 2', label: 'بالو' },
  { family: 'IBM Plex Sans Arabic', label: 'IBM بلكس' },
  { family: 'Alexandria', label: 'الإسكندرية' },
  { family: 'Kufam', label: 'كوفام' },
  { family: 'Marhey', label: 'مرحي (حركي)' },
  { family: 'Readex Pro', label: 'ريدكس' },
  { family: 'Rubik', label: 'روبيك' },
  { family: 'Rakkas', label: 'رقاص (عريض)' },
  { family: 'Lalezar', label: 'لاله زار' },
  { family: 'Katibeh', label: 'كاتبة' },
  { family: 'Jomhuria', label: 'جمهورية' },
  { family: 'Qahiri', label: 'قاهري' },
  { family: 'Gulzar', label: 'كلزار (نستعليق)' },
  { family: 'Vibes', label: 'فايبس' },
  {
    family: '-apple-system, "SF Pro Display", "SF Pro Text", system-ui, sans-serif',
    label: 'آيفون (SF)',
  },
  {
    family: '"SF Arabic", -apple-system, "Geeza Pro", system-ui, sans-serif',
    label: 'آيفون عربي',
  },
];

// خطوط إنجليزية (عدد محدود وأنيق)
export const STORY_FONTS_EN: StoryFontOption[] = [
  { family: 'Poppins', label: 'Modern' },
  { family: 'Playfair Display', label: 'Classic' },
  { family: 'Great Vibes', label: 'Signature' },
  { family: 'Courier Prime', label: 'Typewriter' },
  { family: 'Cormorant Garamond', label: 'Elegant' },
  { family: 'Bebas Neue', label: 'Bold' },
  { family: 'Creepster', label: 'Halloween' },
  { family: '"Helvetica Neue", Helvetica, Arial, sans-serif', label: 'iPhone' },
];

export const STORY_TEXT_COLORS: string[] = [
  '#FFFFFF',
  '#000000',
  '#8E8E93',
  '#C7C7CC',
  '#FF3B30',
  '#E53E3E',
  '#FF2D55',
  '#F687B3',
  '#FF9500',
  '#F56565',
  '#FFCC00',
  '#F6E05E',
  '#34C759',
  '#4CAF50',
  '#68D391',
  '#00C7BE',
  '#4FD1C5',
  '#38B2AC',
  '#007AFF',
  '#4299E1',
  '#63B3ED',
  '#5856D6',
  '#667EEA',
  '#3F51B5',
  '#AF52DE',
  '#9F7AEA',
  '#B794F4',
  '#E91E63',
  '#9C27B0',
  '#795548',
  '#8B5E34',
  '#FBD38D',
  '#FEB2B2',
  '#9AE6B4',
  '#FAF089',
  '#2D3748',
  '#1A202C',
  '#4A5568',
  '#ED64A6',
  '#ED8936',
];

export interface StoryTextBackgroundPreset {
  key: string;
  label: string;
  background: string;
}

// خلفية النص: تُبدَّل بالضغط على الزر نفسه
export const STORY_TEXT_BACKGROUNDS: StoryTextBackgroundPreset[] = [
  { key: 'none', label: 'بدون خلفية', background: 'transparent' },
  { key: 'black', label: 'أسود', background: 'rgba(0, 0, 0, 0.65)' },
  { key: 'white', label: 'أبيض', background: '#FFFFFF' },
  { key: 'red', label: 'أحمر', background: '#E53E3E' },
  { key: 'blue', label: 'أزرق', background: '#2B6CB0' },
  { key: 'green', label: 'أخضر', background: '#2F855A' },
  { key: 'yellow', label: 'أصفر', background: '#F6E05E' },
  { key: 'purple', label: 'بنفسجي', background: '#6B46C1' },
  { key: 'pink', label: 'وردي', background: '#D53F8C' },
  { key: 'gradient', label: 'تدرّج', background: 'linear-gradient(90deg, #E53E3E, #805AD5)' },
];

export const STORY_TEXT_ANIMATIONS: { key: StoryTextAnimation; label: string }[] = [
  { key: 'none', label: 'عادي' },
  { key: 'typewriter', label: 'آلة كاتبة' },
  { key: 'pop', label: 'انبثاق' },
  { key: 'slide-up', label: 'من الأسفل' },
  { key: 'slide-down', label: 'من الأعلى' },
  { key: 'slide-right', label: 'من اليمين' },
  { key: 'slide-left', label: 'من اليسار' },
  { key: 'bounce', label: 'قفز' },
  { key: 'glow', label: 'توهج' },
];

export const STORY_TEXT_ALIGNMENTS_ORDER: StoryTextAlign[] = ['right', 'center', 'left'];

export function nextStoryTextAlign(align: StoryTextAlign): StoryTextAlign {
  const index = STORY_TEXT_ALIGNMENTS_ORDER.indexOf(align);
  return STORY_TEXT_ALIGNMENTS_ORDER[(index + 1) % STORY_TEXT_ALIGNMENTS_ORDER.length];
}

export const STORY_TEXT_ALIGN_LABELS: Record<StoryTextAlign, string> = {
  right: 'محاذاة لليمين',
  center: 'محاذاة للمنتصف',
  left: 'محاذاة لليسار',
};
