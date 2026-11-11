/**
 * الحالة الفارغة الموحدة لكل التطبيق: شعار صغير في المنتصف وتحته كلمة «لا يوجد» فقط.
 * تُستبدل بكل نصوص الخلاء والهياكل المفرغة (قوائم، شبكات، بحث، إشعارات...).
 */
export default function EmptyState({ className = '' }: { className?: string }) {
  return (
    <div
      role="status"
      aria-label="لا يوجد"
      dir="rtl"
      className={`flex flex-col items-center justify-center gap-3 py-10 text-center ${className}`}
    >
      <img src="/favicon.svg" alt="" aria-hidden="true" className="h-12 w-12 opacity-60" />
      <span className="text-sm font-medium text-zinc-500">لا يوجد</span>
    </div>
  );
}
