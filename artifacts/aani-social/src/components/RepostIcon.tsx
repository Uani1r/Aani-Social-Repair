type RepostIconProps = {
  active: boolean;
  size?: number;
  strokeWidth?: number;
  className?: string;
};

/**
 * أيقونة إعادة النشر: بيضاء دائماً (لا تتغير للأحمر إطلاقاً)،
 * وعند التفعيل تظهر علامة صح صغيرة داخل الأيقونة للتأكيد،
 * وتزول عند إلغاء الريبوست.
 */
export default function RepostIcon({
  active,
  size = 18,
  strokeWidth = 2,
  className,
}: RepostIconProps) {
  const checkSize = Math.max(8, Math.round(size * 0.52));
  return (
    <span
      aria-hidden="true"
      className={`relative inline-flex items-center justify-center ${className || ''}`}
      style={{ width: size, height: size }}
    >
      <svg
        width={size}
        height={size}
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth={strokeWidth}
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="M20.7 10a8.2 8.2 0 0 0-14-5.7L4.2 7" />
        <path d="m4.2 3.9-.1 3.1 3.1.1" />
        <path d="M3.3 14a8.2 8.2 0 0 0 14 5.7l2.5-2.7" />
        <path d="m19.8 20.1.1-3.1-3.1-.1" />
      </svg>
      {active && (
        <svg
          className="absolute inset-0 m-auto"
          width={checkSize}
          height={checkSize}
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth={3.4}
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M20 6 9 17l-5-5" />
        </svg>
      )}
    </span>
  );
}
