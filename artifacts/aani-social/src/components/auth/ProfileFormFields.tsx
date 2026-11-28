import type { CSSProperties } from 'react';

import { FemaleDefaultAvatar, MaleDefaultAvatar } from '@/components/DefaultAvatar';
import { PRIVACY_PATH, TERMS_PATH } from '@/lib/onboarding';
import { USERNAME_HINT, USERNAME_MAX_LENGTH } from '@/lib/usernameRules';
import type { ProfileDraft, ProfileGender } from '@/lib/profileCompletion';

/**
 * حقول الملف الشخصي في التسجيل وإكمال التسجيل — مكوّن واحد يُعاد استخدامه.
 *
 * نفس الحقول في التسجيل بالبريد وفي إكمال تسجيل Google: الاسم الكامل، اسم
 * المستخدم، تاريخ الميلاد (birth_date)، الجنس باختيار صريح، والموافقة على
 * الشروط وسياسة الخصوصية (محددة افتراضياً وقابلة للإلغاء).
 *
 * لا بريد ولا كلمة مرور هنا: مستخدم Google لا يُطلب منه ما ليس عليه.
 */

export type ProfileFormFieldsProps = {
  draft: ProfileDraft;
  onChange: (patch: Partial<ProfileDraft>) => void;
  disabled?: boolean;
  /** رسالة تحت حقل اسم المستخدم: صيغة أو تحقق توفر. */
  usernameNotice?: string;
  usernameNoticeTone?: 'neutral' | 'ok' | 'error';
  /** هل يُعرض الحقل تحت عنوان فرعي (شاشة الإكمال)؟ */
  heading?: string;
};

export function ProfileFormFields({
  draft,
  onChange,
  disabled = false,
  usernameNotice,
  usernameNoticeTone = 'neutral',
  heading,
}: ProfileFormFieldsProps) {
  const noticeColor = usernameNoticeTone === 'ok'
    ? '#28553a'
    : usernameNoticeTone === 'error'
      ? '#74442e'
      : '#65716c';

  const selectGender = (gender: ProfileGender) => {
    if (disabled) return;
    onChange({ gender });
  };

  return (
    <>
      {heading && <p style={styles.heading}>{heading}</p>}

      <div style={styles.formGroup}>
        <label style={styles.label} htmlFor="auth-full-name">الاسم الكامل</label>
        <input
          id="auth-full-name"
          type="text"
          required
          maxLength={120}
          autoComplete="name"
          value={draft.fullName}
          onChange={event => onChange({ fullName: event.target.value })}
          style={styles.input}
          disabled={disabled}
        />
      </div>

      <div style={styles.formGroup}>
        <label style={styles.label} htmlFor="auth-username">اسم المستخدم</label>
        <div style={styles.usernameRow}>
          <span style={styles.usernamePrefix} aria-hidden="true">@</span>
          <input
            id="auth-username"
            type="text"
            required
            minLength={1}
            maxLength={USERNAME_MAX_LENGTH}
            pattern="[A-Za-z0-9_.]+"
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            autoComplete="username"
            dir="ltr"
            placeholder="username"
            value={draft.username}
            onChange={event => onChange({ username: event.target.value })}
            style={styles.usernameInput}
            disabled={disabled}
            aria-describedby="auth-username-hint"
          />
        </div>
        <span id="auth-username-hint" style={styles.hint}>{USERNAME_HINT}</span>
        {usernameNotice && (
          <span style={{ ...styles.hint, color: noticeColor, fontWeight: 700 }} role="status">
            {usernameNotice}
          </span>
        )}
      </div>

      <div style={styles.formGroup}>
        <label style={styles.label} htmlFor="auth-birth-date">تاريخ الميلاد</label>
        <input
          id="auth-birth-date"
          type="date"
          required
          min="1900-01-01"
          max={new Date().toISOString().slice(0, 10)}
          value={draft.birthDate}
          onChange={event => onChange({ birthDate: event.target.value })}
          style={styles.input}
          disabled={disabled}
        />
      </div>

      <div style={styles.formGroup}>
        <span style={styles.label}>الجنس</span>
        <div style={styles.genderRow}>
          <button
            type="button"
            onClick={() => selectGender('male')}
            style={{ ...styles.genderCard, borderColor: draft.gender === 'male' ? '#6266C7' : '#d8dfdb' }}
            aria-pressed={draft.gender === 'male'}
            disabled={disabled}
          >
            <MaleDefaultAvatar className="h-20 w-20" />
            <span style={styles.genderLabel}>ذكر</span>
          </button>
          <button
            type="button"
            onClick={() => selectGender('female')}
            style={{ ...styles.genderCard, borderColor: draft.gender === 'female' ? '#6266C7' : '#d8dfdb' }}
            aria-pressed={draft.gender === 'female'}
            disabled={disabled}
          >
            <FemaleDefaultAvatar className="h-20 w-20" />
            <span style={styles.genderLabel}>أنثى</span>
          </button>
        </div>
      </div>

      <div style={styles.formGroup}>
        <label style={styles.consentRow} htmlFor="auth-terms">
          <input
            id="auth-terms"
            type="checkbox"
            checked={draft.termsAccepted}
            onChange={event => onChange({ termsAccepted: event.target.checked })}
            style={styles.consentCheckbox}
            disabled={disabled}
          />
          <span style={styles.consentText}>
            أوافق على{' '}
            <a href={TERMS_PATH} target="_blank" rel="noreferrer" style={styles.consentLink}>الشروط والأحكام</a>
            {' '}و{' '}
            <a href={PRIVACY_PATH} target="_blank" rel="noreferrer" style={styles.consentLink}>سياسة الخصوصية</a>.
          </span>
        </label>
      </div>
    </>
  );
}

const styles: Record<string, CSSProperties> = {
  heading: {
    margin: '0 0 12px',
    fontSize: '14px',
    fontWeight: 700,
    color: '#243b35',
  },
  formGroup: { marginBottom: '18px' },
  label: {
    display: 'block',
    fontSize: '14px',
    fontWeight: 700,
    color: '#243b35',
    marginBottom: '8px',
  },
  input: {
    width: '100%',
    padding: '16px',
    border: '1px solid #d8dfdb',
    borderRadius: '12px',
    backgroundColor: '#ffffff',
    fontSize: '14px',
    color: '#243b35',
    outline: 'none',
    boxSizing: 'border-box',
    fontFamily: "'Tajawal', sans-serif",
  },
  usernameRow: {
    display: 'flex',
    alignItems: 'center',
    gap: '6px',
    border: '1px solid #d8dfdb',
    borderRadius: '12px',
    backgroundColor: '#ffffff',
    paddingInlineStart: '12px',
  },
  usernamePrefix: {
    fontSize: '14px',
    fontWeight: 700,
    color: '#65716c',
  },
  usernameInput: {
    flex: 1,
    minWidth: 0,
    padding: '16px 16px 16px 0',
    border: 'none',
    outline: 'none',
    backgroundColor: 'transparent',
    fontSize: '14px',
    color: '#243b35',
    fontFamily: "'Tajawal', sans-serif",
  },
  hint: {
    display: 'block',
    marginTop: '6px',
    fontSize: '12px',
    lineHeight: 1.6,
    color: '#65716c',
  },
  genderRow: { display: 'flex', gap: '12px' },
  genderCard: {
    flex: 1,
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    gap: '10px',
    padding: '16px 8px',
    border: '2px solid #d8dfdb',
    borderRadius: '12px',
    backgroundColor: '#ffffff',
    cursor: 'pointer',
  },
  genderLabel: { fontSize: '14px', fontWeight: 700, color: '#243b35' },
  consentRow: {
    display: 'flex',
    alignItems: 'flex-start',
    gap: '10px',
    cursor: 'pointer',
  },
  consentCheckbox: {
    marginTop: '3px',
    width: '18px',
    height: '18px',
    flexShrink: 0,
    accentColor: '#243b35',
  },
  consentText: {
    fontSize: '13px',
    lineHeight: 1.8,
    color: '#243b35',
  },
  consentLink: {
    color: '#6266C7',
    fontWeight: 700,
    textDecoration: 'underline',
  },
};

export default ProfileFormFields;
