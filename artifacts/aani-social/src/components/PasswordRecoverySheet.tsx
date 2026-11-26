import { useEffect, useState, type FormEvent } from 'react';
import { toast } from 'sonner';

import { accountAuthErrorMessage, MIN_PASSWORD_LENGTH } from '@/lib/accountAuth';
import { supabase, supabaseConfigured } from '@/lib/supabase';

/**
 * نموذج تعيين كلمة مرور بعد فتح رابط التحقق من البريد.
 *
 * رابط الاستعادة يثبت ملكية البريد لدى Supabase (حدث PASSWORD_RECOVERY)،
 * ولهذا لا تُطلب كلمة المرور الحالية هنا — وهذا هو المسار الآمن للحسابات
 * التي أُنشئت عبر Google أو Apple ولا تملك كلمة مرور محلية. لا signOut ولا
 * ربط هوية جديد: الجلسة تبقى قائمة بعد الحفظ.
 *
 * كلمة المرور لا تُخزَّن في أي جدول ولا تُطبع في السجلات — تُمرَّر إلى
 * `auth.updateUser` مباشرة.
 */
export default function PasswordRecoverySheet({
  open,
  onClose,
  onSaved,
}: {
  open: boolean;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [password, setPassword] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) return;
    setPassword('');
    setConfirmation('');
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', closeOnEscape);
    return () => window.removeEventListener('keydown', closeOnEscape);
  }, [open, onClose]);

  if (!open) return null;

  const savePassword = async (event: FormEvent) => {
    event.preventDefault();
    if (saving) return;
    if (!supabaseConfigured) {
      toast.error('إعدادات الاتصال بقاعدة البيانات غير مكتملة.');
      return;
    }
    if (password.length < MIN_PASSWORD_LENGTH) {
      toast.error(`اختر كلمة مرور من ${MIN_PASSWORD_LENGTH} أحرف على الأقل.`);
      return;
    }
    if (password !== confirmation) {
      toast.error('كلمتا المرور غير متطابقتين.');
      return;
    }

    setSaving(true);
    try {
      // جلسة الاستعادة نفسها تثبت ملكية البريد؛ الحفظ هنا لا يسجّل الخروج.
      const { error } = await supabase.auth.updateUser({ password });
      if (error) throw error;
      setPassword('');
      setConfirmation('');
      onSaved();
      toast.success('تم تعيين كلمة المرور. جلستك ما زالت قائمة.');
    } catch (error) {
      toast.error(accountAuthErrorMessage(error, 'تعذر تعيين كلمة المرور. اطلب رابط تحقق جديداً ثم حاول مجدداً.'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-[1200] flex items-center justify-center bg-black/75 p-4 backdrop-blur-sm" onClick={onClose}>
      <section
        role="dialog"
        aria-modal="true"
        aria-labelledby="password-recovery-title"
        aria-describedby="password-recovery-description"
        className="w-full max-w-sm rounded-2xl border border-white/10 bg-[#0a0a0a] p-5 text-white shadow-2xl"
        onClick={event => event.stopPropagation()}
      >
        <h3 id="password-recovery-title" className="text-base font-bold">تعيين كلمة مرور جديدة</h3>
        <p id="password-recovery-description" className="mt-2 text-sm leading-6 text-neutral-400">
          تحققنا من ملكية بريد الحساب عبر الرابط. اختر كلمة مرور جديدة — جلستك على هذا الجهاز تبقى مفتوحة.
        </p>
        <form onSubmit={event => void savePassword(event)} className="mt-4 space-y-3">
          <label className="block space-y-1.5 text-xs font-semibold text-zinc-300" htmlFor="password-recovery-new">
            كلمة المرور الجديدة
            <input
              id="password-recovery-new"
              type="password"
              autoComplete="new-password"
              minLength={MIN_PASSWORD_LENGTH}
              required
              value={password}
              onChange={event => setPassword(event.target.value)}
              className="w-full rounded-xl border border-white/10 bg-white/[0.04] px-3 py-2.5 text-sm text-white outline-none focus:border-white/25"
            />
          </label>
          <label className="block space-y-1.5 text-xs font-semibold text-zinc-300" htmlFor="password-recovery-confirm">
            تأكيد كلمة المرور الجديدة
            <input
              id="password-recovery-confirm"
              type="password"
              autoComplete="new-password"
              minLength={MIN_PASSWORD_LENGTH}
              required
              value={confirmation}
              onChange={event => setConfirmation(event.target.value)}
              className="w-full rounded-xl border border-white/10 bg-white/[0.04] px-3 py-2.5 text-sm text-white outline-none focus:border-white/25"
            />
          </label>
          <div className="flex gap-3 pt-1">
            <button
              type="button"
              onClick={onClose}
              className="flex-1 rounded-xl border border-white/10 bg-white/[0.06] px-4 py-3 text-sm font-semibold text-white transition hover:bg-white/10"
            >
              إلغاء
            </button>
            <button
              type="submit"
              disabled={saving || password.length < MIN_PASSWORD_LENGTH || password !== confirmation}
              className="flex-1 rounded-xl bg-white px-4 py-3 text-sm font-bold text-black transition hover:bg-zinc-200 disabled:cursor-wait disabled:opacity-60"
            >
              {saving ? 'جارٍ الحفظ...' : 'حفظ كلمة المرور'}
            </button>
          </div>
        </form>
      </section>
    </div>
  );
}
