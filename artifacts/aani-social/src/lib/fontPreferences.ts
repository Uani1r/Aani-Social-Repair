export const FONT_PREFERENCES = [
  { id: 'alexandria', label: 'Alexandria', family: "'Alexandria', sans-serif", previewClass: 'font-preview-alexandria' },
  { id: 'ibm-plex-sans-arabic', label: 'IBM Plex Sans Arabic', family: "'IBM Plex Sans Arabic', sans-serif", previewClass: 'font-preview-ibm-plex-sans-arabic' },
  { id: 'tajawal', label: 'Tajawal', family: "'Tajawal', sans-serif", previewClass: 'font-preview-tajawal' },
  { id: 'cairo', label: 'Cairo', family: "'Cairo', sans-serif", previewClass: 'font-preview-cairo' },
  { id: 'noto-sans-arabic', label: 'Noto Sans Arabic', family: "'Noto Sans Arabic', sans-serif", previewClass: 'font-preview-noto-sans-arabic' },
] as const;

export type FontPreference = typeof FONT_PREFERENCES[number]['id'];

export const DEFAULT_FONT_PREFERENCE: FontPreference = 'alexandria';
const FONT_STORAGE_KEY = 'aani_font_preference';

export function isFontPreference(value: unknown): value is FontPreference {
  return typeof value === 'string' && FONT_PREFERENCES.some(font => font.id === value);
}

export function normalizeFontPreference(value: unknown): FontPreference {
  return isFontPreference(value) ? value : DEFAULT_FONT_PREFERENCE;
}

export function readLocalFontPreference(): FontPreference {
  try {
    return normalizeFontPreference(window.localStorage.getItem(FONT_STORAGE_KEY));
  } catch {
    return DEFAULT_FONT_PREFERENCE;
  }
}

export function resolveFontPreference(profileValue: unknown, localValue: unknown): FontPreference {
  if (isFontPreference(profileValue)) return profileValue;
  if (isFontPreference(localValue)) return localValue;
  return DEFAULT_FONT_PREFERENCE;
}

export function fontPreferenceLabel(value: unknown): string {
  const fontId = normalizeFontPreference(value);
  return FONT_PREFERENCES.find(font => font.id === fontId)?.label || 'Alexandria';
}

export function applyFontPreference(value: unknown): FontPreference {
  const fontId = normalizeFontPreference(value);
  const font = FONT_PREFERENCES.find(option => option.id === fontId) || FONT_PREFERENCES[0];
  if (typeof document !== 'undefined') {
    document.documentElement.style.setProperty('--app-font-family', font.family);
  }
  try {
    window.localStorage.setItem(FONT_STORAGE_KEY, fontId);
  } catch {
    // Font still applies for this session when storage is unavailable.
  }
  return fontId;
}
