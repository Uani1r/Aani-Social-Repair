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
      <path d="M20.7 10a8.2 8.2 0 0 0-14-5.7L4.2 7" />
      <path d="m4.2 3.9-.1 3.1 3.1.1" stroke={arrowColor} />
      <path d="M3.3 14a8.2 8.2 0 0 0 14 5.7l2.5-2.7" />
      <path d="m19.8 20.1.1-3.1-3.1-.1" stroke={arrowColor} />
    </svg>
  );
}
