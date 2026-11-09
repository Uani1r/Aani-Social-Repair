import { useState } from 'react';

type NotificationCategory = 'messages' | 'followers' | 'interactions' | 'stories';
type AppearancePreference = 'dark' | 'light' | 'automatic';
type LanguagePreference = 'ar' | 'en';
type MediaQualityPreference = 'hd' | 'data-saving';

type SettingsPreferences = {
  notifications: Record<NotificationCategory, boolean>;
  appearance: AppearancePreference;
  language: LanguagePreference;
  mediaQuality: MediaQualityPreference;
};

export type ProfileSettingsPreferenceScreen = 'notifications' | 'appearance' | 'language' | 'media-quality';

const notificationOptions: { key: NotificationCategory; label: string; description: string }[] = [
  { key: 'messages', label: 'الرسائل', description: 'إشعارات الرسائل الجديدة' },
  { key: 'followers', label: 'المتابعون الجدد', description: 'طلبات ومتابعات الحساب الجديدة' },
  { key: 'interactions', label: 'التفاعلات', description: 'الإعجابات والتعليقات والإشارات' },
  { key: 'stories', label: 'الستوريات', description: 'التفاعلات ومشاهدات القصص' },
];

const defaultPreferences: SettingsPreferences = {
  notifications: { messages: true, followers: true, interactions: true, stories: true },
  appearance: 'dark',
  language: 'ar',
  mediaQuality: 'hd',
};

function readPreferences(userId: string): SettingsPreferences {
  if (typeof window === 'undefined') return defaultPreferences;
  try {
    const stored = window.localStorage.getItem(`aani-settings-preferences:${userId}`);
    if (!stored) return defaultPreferences;
    const parsed = JSON.parse(stored) as Partial<SettingsPreferences>;
    const notifications = parsed.notifications;
    return {
      notifications: {
        messages: notifications?.messages !== false,
        followers: notifications?.followers !== false,
        interactions: notifications?.interactions !== false,
        stories: notifications?.stories !== false,
      },
      appearance: parsed.appearance === 'light' || parsed.appearance === 'automatic' ? parsed.appearance : 'dark',
      language: parsed.language === 'en' ? 'en' : 'ar',
      mediaQuality: parsed.mediaQuality === 'data-saving' ? 'data-saving' : 'hd',
    };
  } catch {
    return defaultPreferences;
  }
}

function PreferenceChoice({
  label,
  description,
  checked,
  onSelect,
}: {
  label: string;
  description: string;
  checked: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={checked}
      onClick={onSelect}
      className="profile-settings-choice"
    >
      <span className="profile-settings-copy">
        <span className="profile-settings-label">{label}</span>
        <span className="profile-settings-description">{description}</span>
      </span>
      <span className={`profile-settings-radio${checked ? ' is-selected' : ''}`} aria-hidden="true"><span /></span>
    </button>
  );
}

export default function ProfileSettingsPreferences({
  currentUserId,
  screen,
}: {
  currentUserId: string;
  screen: ProfileSettingsPreferenceScreen;
}) {
  const [preferences, setPreferences] = useState(() => readPreferences(currentUserId));
  const storageKey = `aani-settings-preferences:${currentUserId}`;

  const savePreferences = (next: SettingsPreferences) => {
    setPreferences(next);
    try {
      window.localStorage.setItem(storageKey, JSON.stringify(next));
    } catch {
      // Preferences remain available for this view if local storage is unavailable.
    }
  };

  if (screen === 'notifications') {
    return (
      <div className="profile-settings-preferences bg-[#0a0a0a] px-4 pb-6 pt-2">
        <p className="profile-settings-note">تُحفظ هذه الخيارات على هذا الجهاز، ولا تتحكم حالياً بإشعارات النظام أو إعدادات الخادم.</p>
        {notificationOptions.map(option => {
          const enabled = preferences.notifications[option.key];
          return (
            <div key={option.key} className="profile-settings-row profile-settings-privacy bg-[#0a0a0a]">
              <div className="profile-settings-copy">
                <span className="profile-settings-label">{option.label}</span>
                <span className="profile-settings-description">{option.description}</span>
              </div>
              <button
                type="button"
                role="switch"
                aria-checked={enabled}
                aria-label={option.label}
                onClick={() => savePreferences({
                  ...preferences,
                  notifications: { ...preferences.notifications, [option.key]: !enabled },
                })}
                className={`profile-settings-switch${enabled ? ' is-enabled' : ''}`}
              >
                <span />
              </button>
            </div>
          );
        })}
      </div>
    );
  }

  if (screen === 'appearance') {
    return (
      <div className="profile-settings-preferences bg-[#0a0a0a] px-4 pb-6 pt-2">
        <p className="profile-settings-note">يُحفظ اختيارك محلياً؛ الواجهة الحالية تعمل بالوضع الداكن حتى تفعيل دعم السمات الكامل.</p>
        <div role="radiogroup" aria-label="المظهر">
          <PreferenceChoice label="داكن" description="مظهر داكن" checked={preferences.appearance === 'dark'} onSelect={() => savePreferences({ ...preferences, appearance: 'dark' })} />
          <PreferenceChoice label="فاتح" description="مظهر فاتح" checked={preferences.appearance === 'light'} onSelect={() => savePreferences({ ...preferences, appearance: 'light' })} />
          <PreferenceChoice label="تلقائي" description="حسب إعداد الجهاز" checked={preferences.appearance === 'automatic'} onSelect={() => savePreferences({ ...preferences, appearance: 'automatic' })} />
        </div>
      </div>
    );
  }

  if (screen === 'language') {
    return (
      <div className="profile-settings-preferences bg-[#0a0a0a] px-4 pb-6 pt-2">
        <p className="profile-settings-note">واجهة التطبيق متاحة بالعربية حالياً؛ اختيار الإنجليزية يُحفظ كتفضيل ولا يترجم الواجهة بعد.</p>
        <div role="radiogroup" aria-label="اللغة">
          <PreferenceChoice label="العربية" description="لغة التطبيق" checked={preferences.language === 'ar'} onSelect={() => savePreferences({ ...preferences, language: 'ar' })} />
          <PreferenceChoice label="English" description="App language" checked={preferences.language === 'en'} onSelect={() => savePreferences({ ...preferences, language: 'en' })} />
        </div>
      </div>
    );
  }

  return (
    <div className="profile-settings-preferences bg-[#0a0a0a] px-4 pb-6 pt-2">
      <p className="profile-settings-note">يُحفظ اختيار الجودة محلياً. لا تُضغط الفيديوهات حالياً، كما أن هذا التفضيل لم يُربط بعد بمسارات رفع الوسائط.</p>
      <div role="radiogroup" aria-label="جودة الوسائط">
        <PreferenceChoice label="جودة HD" description="الحفاظ على جودة الوسائط" checked={preferences.mediaQuality === 'hd'} onSelect={() => savePreferences({ ...preferences, mediaQuality: 'hd' })} />
        <PreferenceChoice label="توفير البيانات" description="استخدام جودة أقل لتقليل استهلاك البيانات" checked={preferences.mediaQuality === 'data-saving'} onSelect={() => savePreferences({ ...preferences, mediaQuality: 'data-saving' })} />
      </div>
    </div>
  );
}
