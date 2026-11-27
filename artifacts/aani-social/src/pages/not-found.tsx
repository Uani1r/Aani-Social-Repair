import { Link } from 'wouter';

/**
 * صفحة 404: خلفية داكنة ونصوص مقروءة (لا ألوان فاتحة مفروضة على السمة
 * الداكنة)، وزرّا عودة واضحان بدل نص تقني عن الراوتر.
 */
export default function NotFound() {
  return (
    <div
      dir="rtl"
      className="min-h-screen w-full flex items-center justify-center bg-[#0b0b0c] px-4 py-10"
    >
      <div className="w-full max-w-md rounded-2xl border border-white/10 bg-[#141414] p-6 text-center shadow-xl">
        <p className="text-sm font-bold tracking-widest text-[#c98a66]">404</p>
        <h1 className="mt-2 text-2xl font-bold text-[#f5f5f5]">الصفحة غير موجودة</h1>
        <p className="mt-3 text-sm leading-6 text-[#a1a1a6]">
          الرابط الذي فتحته غير صحيح أو تغيّر. يمكنك العودة إلى الصفحة الرئيسية أو تسجيل الدخول من جديد.
        </p>
        <div className="mt-6 flex flex-col gap-3 sm:flex-row">
          <Link
            href="/"
            className="flex-1 rounded-2xl bg-[#c98a66] px-4 py-3 text-sm font-bold text-black transition hover:bg-[#d99a76]"
          >
            الصفحة الرئيسية
          </Link>
          <Link
            href="/login"
            className="flex-1 rounded-2xl border border-white/15 bg-white/[0.06] px-4 py-3 text-sm font-bold text-[#f5f5f5] transition hover:bg-white/[0.12]"
          >
            تسجيل الدخول
          </Link>
        </div>
      </div>
    </div>
  );
}
