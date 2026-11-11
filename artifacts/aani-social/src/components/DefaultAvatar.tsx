type DefaultAvatarProps = {
  /** جنس صاحب الملف: أنثى → أيقونة الشعر، غير ذلك → الأيقونة الافتراضية للذكر */
  gender?: 'male' | 'female' | null;
  className?: string;
};

const FIGURE_COLOR = '#000000';
const BACKGROUND_COLOR = '#FFFFFF';

/** جسم الشخصية وياقة البدلة — هندسة موحدة بين النسختين */
const BodyAndTie = () => (
  <>
    <path
      d="M 50 56 A 14 14 0 0 0 36 70 L 36 90 L 64 90 L 64 70 A 14 14 0 0 0 50 56 Z"
      fill={FIGURE_COLOR}
    />
    <path
      d="M 50 63 L 53 70 L 50 77 L 47 70 Z"
      fill={BACKGROUND_COLOR}
    />
  </>
);

/** الأيقونة الافتراضية للذكر: رأس دائري أسود وجسم ببدلة وياقة V بيضاء */
export function MaleDefaultAvatar({ className = '' }: { className?: string }) {
  return (
    <svg viewBox="0 0 100 100" className={className} xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
      <circle cx="50" cy="50" r="50" fill={BACKGROUND_COLOR} />
      <circle cx="50" cy="38" r="14" fill={FIGURE_COLOR} />
      <BodyAndTie />
    </svg>
  );
}

/** الأيقونة الافتراضية للأنثى: نفس هندسة الذكر مع شعر بوب منحني فوق الرأس */
export function FemaleDefaultAvatar({ className = '' }: { className?: string }) {
  return (
    <svg viewBox="0 0 100 100" className={className} xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
      <circle cx="50" cy="50" r="50" fill={BACKGROUND_COLOR} />
      <path
        d="M 39 28 C 39 18, 61 18, 61 28 L 64 28 C 66 18, 61 12, 50 12 C 39 12, 34 18, 36 28 L 39 28 Z"
        fill={FIGURE_COLOR}
      />
      <path
        d="M 37 32 C 32 36, 35 48, 39 48 L 39 52 C 32 52, 28 40, 31 32 C 34 26, 46 20, 50 20 C 54 20, 66 26, 69 32 C 72 40, 68 52, 61 52 L 61 48 C 65 48, 68 36, 63 32 Z"
        fill={FIGURE_COLOR}
      />
      <circle cx="50" cy="38" r="14" fill={FIGURE_COLOR} />
      <BodyAndTie />
    </svg>
  );
}

/**
 * الأيقونة الشخصية الافتراضية الموحدة:
 * تُعرض فقط عندما يكون رابط الصورة الشخصية فارغاً،
 * ويُحدد شكلها من جنس الملف الشخصي (ذكر افتراضياً).
 */
export default function DefaultAvatar({ gender, className = '' }: DefaultAvatarProps) {
  return gender === 'female'
    ? <FemaleDefaultAvatar className={className} />
    : <MaleDefaultAvatar className={className} />;
}
