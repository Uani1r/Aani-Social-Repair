type RepostIconProps = {
  active: boolean;
  size?: number;
  strokeWidth?: number;
  className?: string;
};

export default function RepostIcon({
  active,
  size = 18,
  strokeWidth = 2,
  className,
}: RepostIconProps) {
  const arrowColor = active ? '#ff2a5f' : 'currentColor';

  return (
    <svg
      aria-hidden="true"
      className={className}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M4 7h16" />
      <path d="m16 3 4 4-4 4" stroke={arrowColor} />
      <path d="M20 17H4" />
      <path d="m8 13-4 4 4 4" stroke={arrowColor} />
    </svg>
  );
}
