import { useEffect, useRef, useState } from 'react';
import { useTheme } from 'next-themes';
import { toast } from 'sonner';

import { supabase, supabaseConfigured } from '@/lib/supabase';
import {
  profilePreferencesPatch,
  readLocalUserPreferences,
  saveLocalUserPreferences,
  userPreferencesFromProfile,
  type UserPreferences,
} from '@/lib/userPreferences';
import {
  applyFontPreference,
  DEFAULT_FONT_PREFERENCE,
  FONT_PREFERENCES,
  readLocalFontPreference,
  resolveFontPreference,
  type FontPreference,
} from '@/lib/fontPreferences';
import type { Profile } from '@/lib/types';

type NotificationCategory = keyof UserPreferences['notifications'];

export type ProfileSettingsPreferenceScreen = 'notifications' | 'appearance' | 'language' | 'media-quality' | 'font-style';

const notificationOptions: { key: NotificationCategory; label: string; description: string }[] = [
  { key: 'messages', label: 'الرسائل', description: 'إشعارات الرسائل الجديدة' },
  { key: 'followers', label: 'المتابعون الجدد', description: 'طلبات ومتابعات الحساب الجديدة' },
  { key: 'interactions', label: 'التفاعلات', description: 'الإعجابات والتعليقات والإشارات' },
  { key: 'stories', label: 'الستوريات', description: 'التفاعلات ومشاهدات القصص' },
];

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
  profile,
  onProfileUpdate,
  screen,
}: {
  currentUserId: string;
  profile: Profile;
  onProfileUpdate: (next: Profile) => void;
  screen: ProfileSettingsPreferenceScreen;
}) {
  const [preferences, setPreferences] = useState(() => userPreferencesFromProfile(profile, readLocalUserPreferences(currentUserId)));
  const [fontPreference, setFontPreference] = useState<FontPreference>(() => resolveFontPreference(profile.font_preference, readLocalFontPreference()));
  const { setTheme } = useTheme();
  const saveQueueRef = useRef<Promise<void>>(Promise.resolve());

  useEffect(() => {
    const nextFontPreference = resolveFontPreference(profile.font_preference, readLocalFontPreference());
    setFontPreference(nextFontPreference);
    applyFontPreference(nextFontPreference);
  }, [profile.font_preference]);

  const savePreferences = (next: UserPreferences) => {
    const locked: UserPreferences = { ...next, appearance: 'dark' };
    setPreferences(locked);
    saveLocalUserPreferences(currentUserId, locked);
    setTheme('dark');
    if (typeof document !== 'undefined') {
      document.documentElement.lang = next.language === 'ar' ? 'ar' : 'en';
      document.documentElement.dir = next.language === 'ar' ? 'rtl' : 'ltr';
    }
    onProfileUpdate({ ...profile, ...profilePreferencesPatch(locked) });

    saveQueueRef.current = saveQueueRef.current.then(async () => {
      if (!supabaseConfigured) throw new Error('إعدادات Supabase غير مكتملة.');
      const { error } = await supabase
        .from('profiles')
        .update(profilePreferencesPatch(locked))
        .eq('id', currentUserId);
      if (error) throw error;
    }).catch(error => {
      console.error('[profile settings] تعذرت مزامنة التفضيلات:', error);
      toast.error('حُفظ التفضيل على هذا الجهاز، لكن تعذرت مزامنته مع Supabase. تحقق من تطبيق ترحيل التفضيلات.');
    });
  };

  const saveFontPreference = (nextFontPreference: FontPreference) => {
    setFontPreference(nextFontPreference);
    applyFontPreference(nextFontPreference);
    onProfileUpdate({ ...profile, font_preference: nextFontPreference });

    saveQueueRef.current = saveQueueRef.current.then(async () => {
      if (!supabaseConfigured) throw new Error('إعدادات Supabase غير مكتملة.');
      const { error } = await supabase
        .from('profiles')
        .update({ font_preference: nextFontPreference })
        .eq('id', currentUserId);
      if (error) throw error;
    }).catch(error => {
      console.error('[profile settings] تعذرت مزامنة الخط:', error);
      toast.error('طُبّق الخط وحُفظ على هذا الجهاز، لكن تعذرت مزامنته مع Supabase. تحقق من تطبيق ترحيل الخطوط.');
    });
  };

  if (screen === 'font-style') {
    return (
      <div className="profile-settings-font-preferences px-4 pb-6 pt-2">
        <p className="profile-settings-note">اختر الخط الذي يناسبك؛ يُطبّق فوراً على الواجهة ويُحفظ على هذا الجهاز وفي حسابك.</p>
        <div role="radiogroup" aria-label="نوع الخط">
          {FONT_PREFERENCES.map(font => (
            <button
              key={font.id}
              type="button"
              role="radio"
              aria-checked={fontPreference === font.id}
              onClick={() => saveFontPreference(font.id)}
              className="profile-settings-choice"
            >
              <span className="profile-settings-copy">
                <span className="profile-settings-label">{font.label}</span>
                <span className={`profile-settings-description ${font.previewClass}`}>تطبيق آني - تجربة تواصل عصرية وفخمة</span>
              </span>
              <span className={`profile-settings-radio${fontPreference === font.id ? ' is-selected' : ''}`} aria-hidden="true"><span /></span>
            </button>
          ))}
        </div>
        <button
          type="button"
          onClick={() => saveFontPreference(DEFAULT_FONT_PREFERENCE)}
          disabled={fontPreference === DEFAULT_FONT_PREFERENCE}
          className="profile-settings-action mt-4 w-full disabled:cursor-default disabled:opacity-50"
        >
          استعادة الخط الافتراضي (Alexandria)
        </button>
      </div>
    );
  }

  if (screen === 'notifications') {
    return (
      <div className="profile-settings-preferences px-4 pb-6 pt-2">
        <p className="profile-settings-note">تتحكم هذه المفاتيح في الإشعارات التي تظهر داخل قائمة الإشعارات، وتُزامَن مع حسابك.</p>
        {notificationOptions.map(option => {
          const enabled = preferences.notifications[option.key];
          return (
            <div key={option.key} className="profile-settings-row profile-settings-privacy">
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
      <div className="profile-settings-preferences px-4 pb-6 pt-2">
        <p className="profile-settings-note">الوضع الداكن هو مظهر التطبيق الوحيد حالياً ولا يمكن تغييره.</p>
        <div role="radiogroup" aria-label="المظهر">
          <PreferenceChoice label="داكن" description="الوضع الداكن مفعّل دائماً" checked onSelect={() => savePreferences({ ...preferences, appearance: 'dark' })} />
        </div>
      </div>
    );
  }

  if (screen === 'language') {
    return (
      <div className="profile-settings-preferences px-4 pb-6 pt-2">
        <p className="profile-settings-note">يتغير اتجاه الواجهة ولغتها المعلنة فوراً ويُحفظ الاختيار في حسابك؛ بعض النصوص ما زالت بالعربية.</p>
        <div role="radiogroup" aria-label="اللغة">
          <PreferenceChoice label="العربية" description="من اليمين إلى اليسار" checked={preferences.language === 'ar'} onSelect={() => savePreferences({ ...preferences, language: 'ar' })} />
          <PreferenceChoice label="English" description="Left to right" checked={preferences.language === 'en'} onSelect={() => savePreferences({ ...preferences, language: 'en' })} />
        </div>
      </div>
    );
  }

  return (
    <div className="profile-settings-preferences px-4 pb-6 pt-2">
      <p className="profile-settings-note">تُحفظ جودة الرفع في حسابك وتُستخدم تلقائياً عند رفع الصور. لا يُضغط الفيديو.</p>
      <div role="radiogroup" aria-label="جودة الوسائط">
        <PreferenceChoice label="جودة HD" description="الحفاظ على جودة الصور" checked={preferences.mediaQuality === 'hd'} onSelect={() => savePreferences({ ...preferences, mediaQuality: 'hd' })} />
        <PreferenceChoice label="توفير البيانات" description="ضغط الصور قبل رفعها" checked={preferences.mediaQuality === 'data-saving'} onSelect={() => savePreferences({ ...preferences, mediaQuality: 'data-saving' })} />
      </div>
    </div>
  );
}
