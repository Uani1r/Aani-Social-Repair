import { cn } from '@/lib/utils';

/**
 * الهيكل العظمي الأساسي (Skeleton) مع تأثير الوميض الشامل:
 * الوميض يُقدَّم من .skeleton-box في index.css (Shimmer)، مع احتياطي
 * animate-pulse لأنماط Tailwind التي لا تعتمد على CSS المخصص.
 */
function Skeleton({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      aria-hidden="true"
      className={cn('skeleton-box animate-pulse rounded-md', className)}
      {...props}
    />
  );
}

export { Skeleton };
