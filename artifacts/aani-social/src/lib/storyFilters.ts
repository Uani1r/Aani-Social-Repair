// محرك فلاتر الستوري: تأثيرات CSS حقيقية تُطبَّق على الصورة أو الفيديو.
// مستقل عن محرر الستوري — إضافة فلتر = سطر واحد في STORY_FILTERS.

export type StoryFilterCategory = 'basic' | 'color' | 'light' | 'cinema' | 'beauty' | 'art' | 'extra';

export interface StoryFilter {
  id: string;
  label: string;
  category: StoryFilterCategory;
  /** سلسلة CSS filter الحقيقية */
  filter: string;
  /** طبقة تلوين اختيارية فوق الوسيط */
  overlay?: { color: string; opacity: number; blend: string };
}

export interface StoryAdjustments {
  brightness: number;
  contrast: number;
  saturation: number;
  warmth: number;
  clarity: number;
}

export const DEFAULT_ADJUSTMENTS: StoryAdjustments = {
  brightness: 0,
  contrast: 0,
  saturation: 0,
  warmth: 0,
  clarity: 0,
};

export const STORY_FILTERS: StoryFilter[] = [
  { id: 'original', label: 'أصلي', category: 'basic', filter: 'none' },

  // أساسية
  { id: 'mono', label: 'أبيض وأسود', category: 'basic', filter: 'grayscale(1) contrast(1.06)' },
  { id: 'gray', label: 'رمادي', category: 'basic', filter: 'grayscale(0.6) contrast(1.04)' },
  { id: 'noir', label: 'أحادي داكن', category: 'basic', filter: 'grayscale(1) contrast(1.32) brightness(0.92)' },
  { id: 'silver', label: 'فضي', category: 'basic', filter: 'grayscale(1) brightness(1.12) contrast(0.95)' },
  { id: 'sepia', label: 'سيبيا', category: 'basic', filter: 'sepia(0.65) contrast(1.05)' },

  // ألوان
  { id: 'vivid', label: 'زاهي', category: 'color', filter: 'saturate(1.55) contrast(1.08)' },
  { id: 'calm', label: 'هادئ', category: 'color', filter: 'saturate(0.72) brightness(1.05)' },
  { id: 'faded', label: 'باهت', category: 'color', filter: 'saturate(0.55) contrast(0.9) brightness(1.06)' },
  {
    id: 'warm',
    label: 'دافئ',
    category: 'color',
    filter: 'saturate(1.15) brightness(1.04)',
    overlay: { color: '#FF9F1A', opacity: 0.14, blend: 'soft-light' },
  },
  {
    id: 'cool',
    label: 'بارد',
    category: 'color',
    filter: 'saturate(1.05) brightness(1.02)',
    overlay: { color: '#2E7DFF', opacity: 0.16, blend: 'soft-light' },
  },
  {
    id: 'vintage',
    label: 'فينتج',
    category: 'color',
    filter: 'sepia(0.32) saturate(1.2) contrast(1.06)',
    overlay: { color: '#E0A458', opacity: 0.1, blend: 'soft-light' },
  },
  { id: 'pastel', label: 'باستيل', category: 'color', filter: 'saturate(0.8) brightness(1.12) contrast(0.94)' },
  { id: 'tropical', label: 'استوائي', category: 'color', filter: 'saturate(1.45) hue-rotate(-12deg) contrast(1.05)' },
  { id: 'mint', label: 'نعناعي', category: 'color', filter: 'saturate(1.1) hue-rotate(18deg) brightness(1.03)' },

  // إضاءة
  { id: 'bright', label: 'سطوع عالٍ', category: 'light', filter: 'brightness(1.24) contrast(1.03)' },
  { id: 'softlight', label: 'إضاءة ناعمة', category: 'light', filter: 'brightness(1.1) contrast(0.92) saturate(0.96)' },
  { id: 'moody', label: 'تعتيم سينمائي', category: 'light', filter: 'brightness(0.86) contrast(1.18) saturate(0.9)' },
  { id: 'balance', label: 'توازن الإضاءة', category: 'light', filter: 'brightness(1.06) contrast(1.1)' },
  { id: 'sunset', label: 'غروب', category: 'light', filter: 'brightness(1.04) saturate(1.25)', overlay: { color: '#FF6B35', opacity: 0.16, blend: 'soft-light' } },
  { id: 'shadowlift', label: 'إضاءة الظلال', category: 'light', filter: 'brightness(1.14) contrast(0.88)' },

  // سينمائية
  { id: 'cinema', label: 'سينمائي', category: 'cinema', filter: 'contrast(1.22) saturate(1.12)', overlay: { color: '#0B3D91', opacity: 0.14, blend: 'soft-light' } },
  { id: 'teal', label: 'تل أورنج', category: 'cinema', filter: 'contrast(1.16) saturate(1.08)', overlay: { color: '#00A6A6', opacity: 0.18, blend: 'soft-light' } },
  { id: 'blockbuster', label: 'بلوكباستر', category: 'cinema', filter: 'contrast(1.3) saturate(1.2) brightness(0.96)' },
  { id: 'noirfilm', label: 'نوار', category: 'cinema', filter: 'grayscale(1) contrast(1.42) brightness(0.9)' },
  { id: 'oldfilm', label: 'فيلم قديم', category: 'cinema', filter: 'sepia(0.45) contrast(1.12) brightness(0.98)', overlay: { color: '#8C6B3F', opacity: 0.12, blend: 'multiply' } },
  { id: 'neonfilm', label: 'نيون', category: 'cinema', filter: 'saturate(1.6) contrast(1.14) hue-rotate(-8deg)' },

  // جمالية
  { id: 'portrait', label: 'بورتريه', category: 'beauty', filter: 'brightness(1.08) contrast(1.04) saturate(1.06)' },
  { id: 'smooth', label: 'نعومة الألوان', category: 'beauty', filter: 'blur(0.4px) brightness(1.06) saturate(0.96)' },
  { id: 'enhanced', label: 'تباين محسّن', category: 'beauty', filter: 'contrast(1.18) saturate(1.1)' },
  { id: 'natural', label: 'طبيعي', category: 'beauty', filter: 'brightness(1.03) contrast(1.02) saturate(1.02)' },
  { id: 'glow', label: 'توهج', category: 'beauty', filter: 'brightness(1.14) contrast(0.94) saturate(1.05)' },

  // فنية
  { id: 'retro', label: 'عتيق', category: 'art', filter: 'sepia(0.5) saturate(1.3) contrast(1.05)', overlay: { color: '#C97B3C', opacity: 0.12, blend: 'soft-light' } },
  { id: 'brown', label: 'درجات البني', category: 'art', filter: 'sepia(0.8) contrast(1.1) brightness(0.96)' },
  { id: 'fadedfilm', label: 'أفلام باهتة', category: 'art', filter: 'sepia(0.35) saturate(0.75) contrast(0.9) brightness(1.05)' },
  { id: 'thermal', label: 'حراري', category: 'art', filter: 'hue-rotate(150deg) saturate(2) contrast(1.1)' },
  { id: 'nepal', label: 'أخضر ساطع', category: 'art', filter: 'hue-rotate(32deg) saturate(1.35) brightness(1.02)' },
  { id: 'duotone', label: 'دوتون', category: 'art', filter: 'grayscale(0.85) contrast(1.15)', overlay: { color: '#7B2CBF', opacity: 0.24, blend: 'color' } },

  // إضافية
  { id: 'dreamy', label: 'حالم', category: 'extra', filter: 'blur(0.6px) brightness(1.1) saturate(1.1)' },
  { id: 'polaroid', label: 'بولارويد', category: 'extra', filter: 'sepia(0.28) saturate(1.15) brightness(1.08) contrast(0.94)' },
  { id: 'goldenhour', label: 'ساعة ذهبية', category: 'extra', filter: 'brightness(1.08) saturate(1.2)', overlay: { color: '#FFC300', opacity: 0.18, blend: 'soft-light' } },
  { id: 'magenta', label: 'أرجواني نيلي', category: 'extra', filter: 'hue-rotate(-25deg) saturate(1.3) brightness(1.02)' },
  { id: 'coldnight', label: 'ليل بارد', category: 'extra', filter: 'brightness(0.92) contrast(1.15) saturate(0.9)', overlay: { color: '#1E3A8A', opacity: 0.18, blend: 'soft-light' } },
  { id: 'candy', label: 'كاندي', category: 'extra', filter: 'saturate(1.5) brightness(1.06) hue-rotate(6deg)' },
];

export function getStoryFilter(id: string): StoryFilter {
  return STORY_FILTERS.find(item => item.id === id) ?? STORY_FILTERS[0];
}

/** يدمج الفلتر المختار مع تعديلات المستخدم في سلسلة CSS واحدة */
export function buildStoryFilterCss(id: string, adjustments: StoryAdjustments, filterOverride?: string): string {
  const preset = getStoryFilter(id);
  const parts: string[] = [];

  if (filterOverride !== undefined) {
    if (filterOverride !== 'none') parts.push(filterOverride);
  } else if (preset.filter !== 'none') {
    parts.push(preset.filter);
  }

  if (adjustments.brightness !== 0) parts.push(`brightness(${1 + adjustments.brightness / 100})`);
  if (adjustments.contrast !== 0 || adjustments.clarity !== 0) {
    const contrast = 1 + (adjustments.contrast + adjustments.clarity * 0.6) / 100;
    parts.push(`contrast(${Math.max(0.2, contrast)})`);
  }
  if (adjustments.saturation !== 0) parts.push(`saturate(${Math.max(0, 1 + adjustments.saturation / 100)})`);
  // لا يوفّر CSS دالة warmth؛ نستخدم sepia للدفء وانحراف hue طفيفًا للبرودة.
  if (adjustments.warmth > 0) parts.push(`sepia(${Math.min(1, adjustments.warmth / 100)})`);
  if (adjustments.warmth < 0) parts.push(`hue-rotate(${adjustments.warmth * 0.4}deg)`);

  return parts.length ? parts.join(' ') : 'none';
}

export function getStoryFilterOverlay(id: string) {
  return getStoryFilter(id).overlay ?? null;
}

/** يحوّل الفلتر + التعديلات إلى مفتاح نصي للتخزين مع القصة */
export function encodeStoryFilterKey(id: string, adjustments: StoryAdjustments): string | null {
  const hasAdjustments = Object.values(adjustments).some(value => value !== 0);
  if (id === 'original' && !hasAdjustments) return null;
  const payload = [id, Math.round(adjustments.brightness), Math.round(adjustments.contrast), Math.round(adjustments.saturation), Math.round(adjustments.warmth), Math.round(adjustments.clarity)].join('|');
  return payload;
}

export function decodeStoryFilterKey(key?: string | null): { id: string; adjustments: StoryAdjustments; css: string } {
  if (!key) {
    return { id: 'original', adjustments: DEFAULT_ADJUSTMENTS, css: 'none' };
  }
  const parts = key.split('|');
  const [id, brightness, contrast, saturation, warmth, clarity] = parts;
  const hasWarmthSlot = parts.length >= 6;
  const adjustments: StoryAdjustments = {
    brightness: Number(brightness) || 0,
    contrast: Number(contrast) || 0,
    saturation: Number(saturation) || 0,
    warmth: hasWarmthSlot ? Number(warmth) || 0 : 0,
    clarity: Number(hasWarmthSlot ? clarity : warmth) || 0,
  };
  return { id: id || 'original', adjustments, css: buildStoryFilterCss(id || 'original', adjustments) };
}
