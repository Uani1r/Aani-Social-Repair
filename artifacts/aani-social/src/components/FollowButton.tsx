import { useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';

import { setFollowState, subscribeToFollowState } from '@/lib/followState';
import { supabase, supabaseConfigured } from '@/lib/supabase';

type FollowButtonProps = {
  targetUserId: string;
  currentUserId: string;
  /** حساب خاص → المتابعة تعني إرسال طلب متابعة */
  isPrivate?: boolean;
  /** الشخص يتابعني → الزر يظهر بنص «رد المتابعة» */
  followsMe?: boolean;
  /** بذرة الحالة من المستضيف (تُستخدم لحظة التركيب قبل وصول المخزن) */
  initialFollowing?: boolean;
  initialRequestSent?: boolean;
  /** يُبلَّغ عند تغيّر المتابعة (لتحديث عدادات المستضيف) */
  onFollowingChange?: (following: boolean) => void;
  className?: string;
  disabled?: boolean;
};

/**
 * زر المتابعة الموحد لكل واجهات التطبيق (الملف الشخصي، قوائم المتابعين
 * والمعجبين، النوافذ المنبثقة): نفس التصميم والحالات والأنيميشن،
 * وحالة المتابعة متزامنة لحظياً عبر مخزن followState المشترك.
 *
 * الحالات: متابعة ← (وميض علامة صح 1.5 ثانية) ← أتابع،
 * ورد المتابعة عندما يتابعني الشخص، وطلب متابعة للحسابات الخاصة.
 */
export default function FollowButton({
  targetUserId,
  currentUserId,
  isPrivate = false,
  followsMe = false,
  initialFollowing = false,
  initialRequestSent = false,
  onFollowingChange,
  className = '',
  disabled = false,
}: FollowButtonProps) {
  const [following, setFollowing] = useState(initialFollowing);
  const [requestSent, setRequestSent] = useState(initialRequestSent);
  // وميض علامة الصح المؤقت (مؤشر نجاح) يختفي بالتلاشي بعد 1.5 ثانية
  const [showCheck, setShowCheck] = useState(false);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const checkTimerRef = useRef<number | null>(null);

  // المزامنة اللحظية: أي زر متابعة لنفس الشخص في أي واجهة يحدّث هذا الزر
  useEffect(() => subscribeToFollowState(targetUserId, state => {
    setFollowing(state.following);
    setRequestSent(state.requestSent);
  }), [targetUserId]);

  useEffect(() => () => {
    if (checkTimerRef.current !== null) window.clearTimeout(checkTimerRef.current);
  }, []);

  const flashCheck = () => {
    setShowCheck(true);
    if (checkTimerRef.current !== null) window.clearTimeout(checkTimerRef.current);
    checkTimerRef.current = window.setTimeout(() => {
      setShowCheck(false);
      checkTimerRef.current = null;
    }, 1500);
  };

  const toggleFollow = async () => {
    if (!supabaseConfigured || !currentUserId || targetUserId === currentUserId || busyRef.current || disabled) return;
    busyRef.current = true;
    setBusy(true);
    const previous = { following, requestSent };
    try {
      if (following) {
        const { error } = await supabase.from('follows').delete()
          .eq('follower_id', currentUserId)
          .eq('following_id', targetUserId);
        if (error) throw error;
        setFollowState(targetUserId, { following: false });
        onFollowingChange?.(false);
      } else if (requestSent) {
        const { error } = await supabase.from('follow_requests').delete()
          .eq('requester_id', currentUserId)
          .eq('recipient_id', targetUserId);
        if (error) throw error;
        setFollowState(targetUserId, { requestSent: false });
      } else if (isPrivate) {
        const { error } = await supabase.from('follow_requests').insert({
          requester_id: currentUserId,
          recipient_id: targetUserId,
        });
        if (error && error.code !== '23505') throw error;
        setFollowState(targetUserId, { requestSent: true });
        toast.success(error ? 'سبق إرسال طلب المتابعة' : 'تم إرسال طلب المتابعة');
      } else {
        // تفاؤلي: «أتابع» فوراً مع وميض علامة الصح، والإدراج في الخلفية
        setFollowState(targetUserId, { following: true });
        onFollowingChange?.(true);
        flashCheck();
        const { error } = await supabase.from('follows').insert({
          follower_id: currentUserId,
          following_id: targetUserId,
        });
        if (error && error.code !== '23505') throw error;
      }
    } catch {
      // تراجع عن التغيير المتفائل وأعد الحالة السابقة في كل الأزرار المتزامنة
      setFollowState(targetUserId, previous);
      onFollowingChange?.(previous.following);
      toast.error('تعذرت تحديث حالة المتابعة. حاول مرة أخرى.');
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };

  const label = following
    ? 'أتابع'
    : requestSent
      ? 'إلغاء طلب المتابعة'
      : followsMe
        ? 'رد المتابعة'
        : isPrivate
          ? 'طلب متابعة'
          : 'متابعة';

  return (
    <button
      type="button"
      onClick={event => {
        event.stopPropagation();
        void toggleFollow();
      }}
      disabled={disabled || busy}
      aria-pressed={following}
      aria-label={following
        ? 'إلغاء المتابعة'
        : requestSent
          ? 'إلغاء طلب المتابعة'
          : followsMe
            ? 'رد المتابعة'
            : isPrivate
              ? 'طلب متابعة'
              : 'متابعة'}
      className={`relative inline-flex h-9 min-w-[85px] shrink-0 items-center whitespace-nowrap rounded-full px-4 text-[13px] font-semibold transition disabled:opacity-50 ${
        requestSent ? 'bg-zinc-800 text-white hover:bg-zinc-700' : 'bg-white text-black hover:bg-neutral-200'
      } ${className}`}
    >
      <span className="invisible inline-flex items-center gap-1.5" aria-hidden="true">
        <span>{label}</span>
        {following && <span className="h-3.5 w-3.5 shrink-0" />}
      </span>
      <span className="absolute inset-0 flex items-center justify-center text-center">{label}</span>
      {following && (
        <span className="absolute left-2 top-1/2 inline-flex h-3.5 w-3.5 -translate-y-1/2 items-center justify-center" aria-hidden="true">
          <svg className={`profile-follow-check${showCheck ? ' is-visible' : ''}`} viewBox="0 0 20 20" aria-hidden="true">
            <path d="M3 10.5 7.4 15 17 5.5" fill="none" stroke="#000" strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} />
          </svg>
        </span>
      )}
    </button>
  );
}
