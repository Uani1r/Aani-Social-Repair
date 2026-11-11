type DefaultAvatarProps = {
  /** جنس صاحب الملف: أنثى → أيقونة الشعر، غير ذلك → أيقونة الذكر الافتراضية */
  gender?: 'male' | 'female' | null;
  className?: string;
};

const FIGURE_COLOR = '#000000';
const BACKGROUND_COLOR = '#FFFFFF';

/**
 * التصميم الأصلي (Previous Default Avatar Design):
 * شخصية هندسية مسطحة — رأس دائري أسود وجسم ببدلة
 * (شبه منحرف مقلوب بزوايا منحنية) مع ربطة عنق بيضاء
 * في وسط الصدر، على دائرة بيضاء.
 */
const BodyWithTie = () => (
  <>
    {/* الجسم: شبه منحرف مقلوب بزوايا منحنية يبدأ أسفل الرأس */}
    <path
      d="M 36 55 L 64 55 C 66.6 55, 68.2 57.2, 67.8 59.8 L 66.8 82 C 66.4 86, 63.2 88.5, 59 88.5 L 41 88.5 C 36.8 88.5, 33.6 86, 33.2 82 L 32.2 59.8 C 31.8 57.2, 33.4 55, 36 55 Z"
      fill={FIGURE_COLOR}
    />
    {/* ياقة البدلة وربطة العنق البيضاء في منتصف الصدر */}
    <path
      d="M 50 52 L 56.5 63.5 L 50 75 L 43.5 63.5 Z"
      fill={BACKGROUND_COLOR}
    />
  </>
);

/** الأيقونة الافتراضية للذكر: رأس دائري وجسم ببدلة وياقة بيضاء */
export function MaleDefaultAvatar({ className = '' }: { className?: string }) {
  return (
    <svg viewBox="0 0 100 100" className={className} xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
      <circle cx="50" cy="50" r="50" fill={BACKGROUND_COLOR} />
      <circle cx="50" cy="35" r="14" fill={FIGURE_COLOR} />
      <BodyWithTie />
    </svg>
  );
}

/** الأيقونة الافتراضية للأنثى: نفس هندسة الذكر مع شعر بوب منحني فوق الرأس */
export function FemaleDefaultAvatar({ className = '' }: { className?: string }) {
  return (
    <svg viewBox="0 0 100 100" className={className} xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
      <circle cx="50" cy="50" r="50" fill={BACKGROUND_COLOR} />
      {/* الشعر: كتلة سوداء تمتد أوسع من الرأس ومن أعلاه حتى منتصف الوجه (بوب منحني) */}
      <ellipse cx="50" cy="28" rx="21" ry="16" fill={FIGURE_COLOR} />
      {/* الرأس الدائري (كما في الذكر تماماً) — يندمج مع الشعر في كتلة واحدة */}
      <circle cx="50" cy="35" r="14" fill={FIGURE_COLOR} />
      {/* خط أبيض منحن يفصل الشعر عن الجبهة */}
      <path
        d="M 39 30 C 41.5 23.5, 46 20.5, 51.5 21.5 C 56 22.4, 59.5 25, 61.5 28.5"
        fill="none"
        stroke={BACKGROUND_COLOR}
        strokeWidth="1.6"
        strokeLinecap="round"
      />
      {/* خط لمعان بيضاء منحن أعلى الشعر */}
      <path
        d="M 57 15.5 C 61 17.5, 64 21, 65.5 25"
        fill="none"
        stroke={BACKGROUND_COLOR}
        strokeWidth="1.6"
        strokeLinecap="round"
      />
      {/* الجسم وياقة البدلة كما في الذكر */}
      <BodyWithTie />
    </svg>
  );
}

/**
 * الأيقونة الشخصية الافتراضية الموحدة (التصميم القديم):
 * تُعرض فقط عندما يكون رابط الصورة الشخصية فارغاً،
 * ويُحدد شكلها من جنس الملف الشخصي (ذكر افتراضياً).
 */
export default function DefaultAvatar({ gender, className = '' }: DefaultAvatarProps) {
  return gender === 'female'
    ? <FemaleDefaultAvatar className={className} />
    : <MaleDefaultAvatar className={className} />;
}
