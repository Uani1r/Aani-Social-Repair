import type { HTMLAttributes } from 'react';
import { cn } from '@/lib/utils';

// مكتبة الهياكل العظمية المركزية (Skeleton Loading):
// تُستبدل بكل نصوص ومؤشرات التحميل القديمة، وتظهر فوراً مكان المحتوى
// الأصلي طالما كانت البيانات قيد التحميل، ثم تُسلَّم للمحتوى الحقيقي
// عبر انتقال ناعم (content-fade-in) دون قفزات في التخطيط.

/** القاعدة: مربع/خط هيكلي مع تأثير الوميض (Shimmer) عبر .skeleton-box في CSS */
export function SkeletonBlock({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      aria-hidden="true"
      className={cn('skeleton-box', className)}
      {...props}
    />
  );
}

/** خط أفقي بطول متغير (w-24، w-1/2 ...) */
export function SkeletonLine({ width = 'w-full', className }: { width?: string; className?: string }) {
  return <span aria-hidden="true" className={cn('skeleton-box block h-3 rounded-full', width, className)} />;
}

/** دائرة (صورة شخصية، زر تفاعل...) */
export function SkeletonCircle({ className }: { className?: string }) {
  return <span aria-hidden="true" className={cn('skeleton-box block rounded-full', className)} />;
}

/** هيكل بطاقة منشور: صورة 4:5 + اسم + وصف + أزرار التفاعل */
export function FeedSkeleton({ count = 3, className }: { count?: number; className?: string }) {
  return (
    <div className={cn('space-y-3', className)} role="status" aria-label="جارٍ تحميل المنشورات">
      {Array.from({ length: count }, (_, index) => (
        <article key={index} className="mx-auto w-full max-w-lg overflow-hidden border-b border-zinc-900 bg-[#0b0b0d] sm:rounded-2xl sm:border sm:border-zinc-900">
          <div className="flex items-center gap-3 px-4 py-3">
            <SkeletonCircle className="h-10 w-10 shrink-0" />
            <div className="min-w-0 flex-1 space-y-2">
              <SkeletonLine width="w-24" />
              <SkeletonLine width="w-16" className="h-2.5 opacity-60" />
            </div>
            <SkeletonCircle className="h-5 w-5 opacity-60" />
          </div>
          <SkeletonBlock className="aspect-[4/5] w-full rounded-none" />
          <div className="flex items-center gap-6 px-4 py-3" aria-hidden="true">
            <SkeletonCircle className="h-6 w-6" />
            <SkeletonCircle className="h-6 w-6" />
            <SkeletonCircle className="h-6 w-6" />
            <SkeletonCircle className="h-6 w-6 opacity-60" />
          </div>
          <div className="space-y-2 px-4 pb-4">
            <SkeletonLine width="w-3/4" />
            <SkeletonLine width="w-1/2" className="opacity-60" />
          </div>
        </article>
      ))}
    </div>
  );
}

/** هيكل الملف الشخصي: الغلاف + الصورة + الإحصائيات + شبكة 3×3 */
export function ProfileSkeleton({ className }: { className?: string }) {
  return (
    <div
      className={cn('mx-auto w-full max-w-[600px] pb-8', className)}
      role="status"
      aria-label="جارٍ تحميل الملف الشخصي"
      dir="rtl"
    >
      <SkeletonBlock className="h-36 w-full rounded-none" />
      <div className="px-4">
        <div className="-mt-10 flex items-end justify-between">
          <SkeletonCircle className="h-24 w-24 shrink-0 border-4 border-black" />
          <SkeletonBlock className="h-8 w-24 rounded-full" />
        </div>
        <div className="mt-4 space-y-2">
          <SkeletonLine width="w-36" className="h-4" />
          <SkeletonLine width="w-24" className="h-3 opacity-60" />
        </div>
        <div className="mt-4 space-y-2">
          <SkeletonLine className="h-3" />
          <SkeletonLine width="w-2/3" className="h-3 opacity-60" />
        </div>
        <div className="mt-5 grid grid-cols-3 gap-2 text-center">
          {[0, 1, 2].map(index => (
            <div key={index} className="space-y-2">
              <SkeletonLine width="w-10" className="mx-auto h-4" />
              <SkeletonLine width="w-14" className="mx-auto h-3 opacity-60" />
            </div>
          ))}
        </div>
        <div className="mt-5 grid grid-cols-3 gap-1.5 sm:gap-2">
          {Array.from({ length: 9 }, (_, index) => (
            <SkeletonBlock key={index} className="aspect-[4/5] w-full rounded-lg" />
          ))}
        </div>
      </div>
    </div>
  );
}

/** هيكل الريلز: إطار شاشة كاملة 9:16 مع أزرار التفاعل يميناً وشرائط الوصف أسفلاً */
export function ReelsSkeleton({ count = 1, className }: { count?: number; className?: string }) {
  return (
    <div className={cn('h-full w-full', className)} role="status" aria-label="جارٍ تحميل الريلز">
      {Array.from({ length: count }, (_, index) => (
        <div key={index} className="relative h-full w-full snap-start overflow-hidden bg-zinc-950">
          <SkeletonBlock className="absolute inset-0 rounded-none opacity-40" />
          <div className="absolute inset-y-5 right-3 flex flex-col items-center gap-5" aria-hidden="true">
            <SkeletonCircle className="h-11 w-11" />
            <SkeletonCircle className="h-9 w-9" />
            <SkeletonCircle className="h-9 w-9" />
            <SkeletonCircle className="h-9 w-9" />
            <SkeletonCircle className="h-9 w-9 opacity-60" />
          </div>
          <div className="absolute inset-x-4 bottom-24 space-y-2.5" aria-hidden="true">
            <div className="flex items-center gap-2.5">
              <SkeletonCircle className="h-9 w-9 shrink-0" />
              <SkeletonLine width="w-24" />
            </div>
            <SkeletonLine width="w-3/4" className="opacity-70" />
            <SkeletonLine width="w-1/2" className="opacity-50" />
          </div>
        </div>
      ))}
    </div>
  );
}

/** هيكل التعليقات: دوائر الصور الشخصية مع خطوط متدرجة الطول */
export function CommentsSkeleton({ count = 4, compact = false, className }: { count?: number; compact?: boolean; className?: string }) {
  const widths = ['w-3/4', 'w-1/2', 'w-2/3', 'w-5/6'];
  return (
    <div
      className={cn('space-y-5 py-4', compact && 'space-y-3 py-2', className)}
      role="status"
      aria-label="جارٍ تحميل التعليقات"
    >
      {Array.from({ length: count }, (_, index) => (
        <div key={index} className="flex items-start gap-3">
          <SkeletonCircle className={cn('shrink-0', compact ? 'h-6 w-6' : 'h-10 w-10')} />
          <div className={cn('min-w-0 flex-1 space-y-2', compact ? 'pt-0.5' : 'pt-1')}>
            <SkeletonLine width="w-20" className={compact ? 'h-2' : ''} />
            <SkeletonLine width={widths[index % widths.length]} className={compact ? 'h-2' : ''} />
          </div>
        </div>
      ))}
    </div>
  );
}

/** هيكل المحادثات/الرسائل: دوائر صور شخصية مع خطوط نصوص أفقية متدرجة الطول */
export function MessagesSkeleton({ count = 6, className }: { count?: number; className?: string }) {
  return (
    <div className={cn('space-y-4 px-4 py-3', className)} role="status" aria-label="جارٍ تحميل المحادثات">
      {Array.from({ length: count }, (_, index) => (
        <div key={index} className="flex items-center gap-3">
          <SkeletonCircle className="h-12 w-12 shrink-0" />
          <div className="min-w-0 flex-1 space-y-2">
            <SkeletonLine width="w-28" />
            <SkeletonLine width={index % 3 === 0 ? 'w-1/2' : index % 3 === 1 ? 'w-2/3' : 'w-3/4'} className="h-2.5 opacity-60" />
          </div>
          <SkeletonLine width="w-10" className="h-2.5 opacity-40" />
        </div>
      ))}
    </div>
  );
}

/** هيكل الإشعارات: بطاقات صفوف (دائرة + سطران + مربع وسائط) */
export function NotificationsSkeleton({ count = 5, className }: { count?: number; className?: string }) {
  return (
    <div className={cn('space-y-2.5 px-4', className)} role="status" aria-label="جارٍ تحميل الإشعارات">
      {Array.from({ length: count }, (_, index) => (
        <div key={index} className="flex items-start gap-3 rounded-2xl border border-white/[0.06] bg-white/[0.02] p-3">
          <SkeletonCircle className="h-10 w-10 shrink-0" />
          <div className="min-w-0 flex-1 space-y-2 pt-1">
            <SkeletonLine width="w-3/4" />
            <SkeletonLine width="w-1/2" className="h-2.5 opacity-60" />
          </div>
          <SkeletonBlock className="h-10 w-10 shrink-0 rounded-xl" />
        </div>
      ))}
    </div>
  );
}

/** هيكل قائمة أشخاص (بحث، طلبات متابعة، إعجابات، مشاهدين...): دائرة + سطران متدرجان */
export function ListSkeleton({ count = 5, compact = false, className }: { count?: number; compact?: boolean; className?: string }) {
  const widths = ['w-3/4', 'w-1/2', 'w-2/3', 'w-5/6'];
  return (
    <div
      className={cn('space-y-3 px-1 py-2', compact && 'space-y-2', className)}
      role="status"
      aria-label="جارٍ تحميل القائمة"
    >
      {Array.from({ length: count }, (_, index) => (
        <div key={index} className="flex items-center gap-3 px-2 py-1">
          <SkeletonCircle className={cn('shrink-0', compact ? 'h-8 w-8' : 'h-12 w-12')} />
          <div className="min-w-0 flex-1 space-y-2">
            <SkeletonLine width="w-28" className={compact ? 'h-2.5' : ''} />
            <SkeletonLine width={widths[(index + 1) % widths.length]} className={compact ? 'h-2 opacity-60' : 'h-2.5 opacity-60'} />
          </div>
        </div>
      ))}
    </div>
  );
}

/** هيكل شبكة صور (المحفوظات، أرشيف القصص، شبكة البروفايل): بلاطات 4:5 */
export function GridSkeleton({ count = 9, className }: { count?: number; className?: string }) {
  return (
    <div className={cn('grid grid-cols-3 gap-1.5 sm:gap-2', className)} role="status" aria-label="جارٍ تحميل الشبكة">
      {Array.from({ length: count }, (_, index) => (
        <SkeletonBlock key={index} className="aspect-[4/5] w-full rounded-xl" />
      ))}
    </div>
  );
}

/** هيكل قائمة مقاطع صوتية: مربع غلاف + سطران */
export function MusicTracksSkeleton({ count = 6, className }: { count?: number; className?: string }) {
  return (
    <div className={cn('space-y-2 px-1 py-2', className)} role="status" aria-label="جارٍ تحميل المكتبة">
      {Array.from({ length: count }, (_, index) => (
        <div key={index} className="flex items-center gap-3 px-2 py-1.5">
          <SkeletonBlock className="h-11 w-11 shrink-0 rounded-lg" />
          <div className="min-w-0 flex-1 space-y-1.5">
            <SkeletonLine width="w-1/2" className="h-2.5" />
            <SkeletonLine width={index % 2 === 0 ? 'w-1/3' : 'w-2/5'} className="h-2 opacity-60" />
          </div>
        </div>
      ))}
    </div>
  );
}
