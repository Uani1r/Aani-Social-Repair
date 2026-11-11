type DefaultAvatarProps = {
  /** يُقبل للتوافق مع الواجهات القديمة — الأيقونة الموحدة واحدة للجميع */
  gender?: 'male' | 'female' | null;
  className?: string;
};

/**
 * الأيقونة الشخصية الافتراضية الموحدة (User Avatar Placeholder):
 * مجسم رمادي بسيط داخل دائرة — نفس تصميم عنصر الصورة الشخصية
 * في صفحة الملف الشخصي (دائرة neutral-800 وشخصية neutral-400).
 * تُعرض في كل الواجهات عندما يكون رابط الصورة الشخصية فارغاً.
 */
const BACKGROUND_COLOR = '#262626'; // neutral-800
const FIGURE_COLOR = '#a3a3a3'; // neutral-400

export function StandardUserAvatar({ className = '' }: { className?: string }) {
  return (
    <svg viewBox="0 0 100 100" className={className} xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
      <circle cx="50" cy="50" r="50" fill={BACKGROUND_COLOR} />
      {/* المجسم الرمادي البسيط: رأس دائري + كتفان مستديران */}
      <circle cx="50" cy="38.5" r="13.5" fill={FIGURE_COLOR} />
      <path
        d="M 50 55.5 C 32 55.5, 24.5 66, 24.5 75.5 L 24.5 92 A 50 50 0 0 0 75.5 92 L 75.5 75.5 C 75.5 66, 68 55.5, 50 55.5 Z"
        fill={FIGURE_COLOR}
      />
    </svg>
  );
}

/** أسماء متوافقة مع الواجهات القديمة — كلها ترسم الأيقونة الموحدة */
export const MaleDefaultAvatar = StandardUserAvatar;
export const FemaleDefaultAvatar = StandardUserAvatar;

export default function DefaultAvatar({ className = '' }: DefaultAvatarProps) {
  return <StandardUserAvatar className={className} />;
}
