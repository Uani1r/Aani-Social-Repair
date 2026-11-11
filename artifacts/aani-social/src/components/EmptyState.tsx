/**
 * الحالة الفارغة الموحدة لكل التطبيق: كلمة «لا يوجد» فقط في المنتصف.
 */
export default function EmptyState({ className = '' }: { className?: string }) {
  return (
    <div
      role="status"
      aria-label="لا يوجد"
      dir="rtl"
      className={`flex flex-col items-center justify-center py-10 text-center ${className}`}
    >
      <span className="text-sm font-medium text-zinc-500">لا يوجد</span>
    </div>
  );
}
