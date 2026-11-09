import type { Profile, ProfileNotificationSettings } from '@/lib/types';

export type AppearancePreference = 'dark' | 'light' | 'system';
export type LanguagePreference = 'ar' | 'en';
export type MediaQualityPreference = 'hd' | 'data-saving';

export type UserPreferences = {
  notifications: ProfileNotificationSettings;
  appearance: AppearancePreference;
  language: LanguagePreference;
  mediaQuality: MediaQualityPreference;
};

const makeDefaultPreferences = (): UserPreferences => ({
  notifications: { messages: true, followers: true, interactions: true, stories: true },
  appearance: 'dark',
  language: 'ar',
  mediaQuality: 'hd',
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function parseAppearance(value: unknown, fallback: AppearancePreference): AppearancePreference {
  if (value === 'dark' || value === 'light' || value === 'system') return value;
  if (value === 'automatic') return 'system';
  return fallback;
}

function parseLanguage(value: unknown, fallback: LanguagePreference): LanguagePreference {
  return value === 'en' || value === 'ar' ? value : fallback;
}

function parseMediaQuality(value: unknown, fallback: MediaQualityPreference): MediaQualityPreference {
  return value === 'hd' || value === 'data-saving' ? value : fallback;
}

function parseNotifications(value: unknown, fallback: ProfileNotificationSettings): ProfileNotificationSettings {
  if (!isRecord(value)) return { ...fallback };
  return {
    messages: typeof value.messages === 'boolean' ? value.messages : fallback.messages,
    followers: typeof value.followers === 'boolean' ? value.followers : fallback.followers,
    interactions: typeof value.interactions === 'boolean' ? value.interactions : fallback.interactions,
    stories: typeof value.stories === 'boolean' ? value.stories : fallback.stories,
  };
}

export function readLocalUserPreferences(userId: string): UserPreferences {
  const defaults = makeDefaultPreferences();
  if (typeof window === 'undefined' || !userId) return defaults;
  try {
    const stored = window.localStorage.getItem(`aani-settings-preferences:${userId}`);
    if (!stored) return defaults;
    const value = JSON.parse(stored) as Record<string, unknown>;
    const mediaQuality = value.data_saver === true || value.hd_uploads === false
      ? 'data-saving'
      : parseMediaQuality(value.mediaQuality, defaults.mediaQuality);
    return {
      notifications: parseNotifications(value.notification_settings ?? value.notifications, defaults.notifications),
      appearance: parseAppearance(value.appearance_preference ?? value.appearance, defaults.appearance),
      language: parseLanguage(value.language_preference ?? value.language, defaults.language),
      mediaQuality,
    };
  } catch {
    return defaults;
  }
}

export function saveLocalUserPreferences(userId: string, preferences: UserPreferences): void {
  if (typeof window === 'undefined' || !userId) return;
  try {
    window.localStorage.setItem(`aani-settings-preferences:${userId}`, JSON.stringify({
      ...preferences,
      notification_settings: preferences.notifications,
      appearance_preference: preferences.appearance,
      language_preference: preferences.language,
      hd_uploads: preferences.mediaQuality === 'hd',
      data_saver: preferences.mediaQuality === 'data-saving',
    }));
  } catch {
    // The database remains the durable source when local storage is unavailable.
  }
}

export function userPreferencesFromProfile(profile: Profile | null, local: UserPreferences): UserPreferences {
  const profileNotifications = parseNotifications(profile?.notification_settings, local.notifications);
  const appearance = parseAppearance(profile?.appearance_preference, local.appearance);
  const language = parseLanguage(profile?.language_preference, local.language);
  const mediaQuality = typeof profile?.data_saver === 'boolean' || typeof profile?.hd_uploads === 'boolean'
    ? profile.data_saver === true || profile.hd_uploads === false ? 'data-saving' : 'hd'
    : local.mediaQuality;

  return { notifications: profileNotifications, appearance, language, mediaQuality };
}

export function profilePreferencesPatch(preferences: UserPreferences): Pick<Profile, 'notification_settings' | 'appearance_preference' | 'language_preference' | 'hd_uploads' | 'data_saver'> {
  return {
    notification_settings: preferences.notifications,
    appearance_preference: preferences.appearance,
    language_preference: preferences.language,
    hd_uploads: preferences.mediaQuality === 'hd',
    data_saver: preferences.mediaQuality === 'data-saving',
  };
}
