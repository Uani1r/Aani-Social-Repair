import {
  useCallback,
  useEffect,
  useState,
  type SyntheticEvent as ReactSyntheticEvent,
} from 'react';
import { createPortal } from 'react-dom';
import { Plus, X } from 'lucide-react';

import { ListSkeleton } from '@/components/Skeletons';
import { cn } from '@/lib/utils';
import { SignedImage } from '@/components/SignedMedia';
import { useBottomSheetDismiss } from '@/hooks/useBottomSheetDismiss';
import { useOverlayBack } from '@/hooks/useOverlayBack';
import { supabase, supabaseConfigured } from '@/lib/supabase';
import { displayName, formatDate } from '@/lib/types';
import {
  formatPopularity,
  fetchGiftCatalog,
  fetchMyBalance,
  fetchPopularity,
  fetchReceivedGifts,
  resolveSendAttempt,
  sendGift,
  type Gift,
  type ReceivedGift,
  type SendAttempt,
  type SendGiftResult,
} from '@/lib/gifts';
import { toast } from 'sonner';

type PopularityGiftsSheetProps = {
  open: boolean;
  /** صاحب الملف الشخصي الذي تُفتح النافذة منه (أي مستلم الهدايا المعروضة). */
  userId: string;
  /** اسم عرض المستلم لعرضه في واجهة إرسال الهدية. */
  recipientName?: string;
  currentUserId: string;
  onClose: () => void;
  /** يُستدعى عند تغيُّر شعبية المستلم بعد عملية إرسال ناجحة. */
  onPopularityChange?: (value: number) => void;
};

/* ---------- ثوابت التصميم ---------- */

const GREEN_COLOR = '#22C55E'; // لون نص الربح المجاني

/* رموز الهدايا الاحتياطية عند عدم توفر صورة من كتالوج قاعدة البيانات. */
const giftEmoji = (name: string): string => {
  if (/وردة/.test(name)) return '🌹';
  if (/قلب/.test(name)) return '❤️';
  if (/تاج/.test(name)) return '👑';
  if (/ماسة/.test(name)) return '💎';
  if (/أفعى/.test(name)) return '🐍';
  if (/صقر/.test(name)) return '🦅';
  return '🎁';
};

export default function PopularityGiftsSheet({
  open,
  userId,
  recipientName,
  currentUserId,
  onClose,
  onPopularityChange,
}: PopularityGiftsSheetProps) {
  useOverlayBack(open, onClose);
  const [showLog, setShowLog] = useState(false);
  // حالات دخول/خروج للحركة السلسة (صعود وهبوط خلال 0.4s)
  const [entering, setEntering] = useState(false);
  const [exiting, setExiting] = useState(false);
  const [enteringLog, setEnteringLog] = useState(false);
  const [exitingLog, setExitingLog] = useState(false);

  const [items, setItems] = useState<ReceivedGift[]>([]);
  const [totalReceived, setTotalReceived] = useState(0);
  const [page, setPage] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [catalog, setCatalog] = useState<Gift[]>([]);
  const [catalogLoading, setCatalogLoading] = useState(false);
  const [balance, setBalance] = useState(0);
  const [popularity, setPopularity] = useState(0);
  const [selectedGift, setSelectedGift] = useState<Gift | null>(null);
  // العملية المعلّقة (إن وُجدة) تقفل اختيار الهدية وتحمل مفتاح عملية الإرسال.
  const [attempt, setAttempt] = useState<SendAttempt | null>(null);
  const sending = attempt?.status === 'sending';

  // عملية شحن الرصيد معطلة إلى حين تكامل مزود دفع فعّال من جهة الخادم.
  // لا يُسمح بإدخال مبلغ أو مرجع دفع أو مزود من واجهة المستخدم؛ لا يُضاف أي رصيد.

  const {
    dragOffset,
    dragging,
    onClickCapture,
    onPointerDown,
    onTouchStart,
    onTouchMove,
    onTouchEnd,
    onTouchCancel,
  } = useBottomSheetDismiss(open, onClose);

  const closeLog = () => {
    setSelectedGift(null);
    setShowLog(false);
  };

  const {
    dragOffset: logDragOffset,
    dragging: logDragging,
    onClickCapture: logOnClickCapture,
    onPointerDown: logOnPointerDown,
    onTouchStart: logOnTouchStart,
    onTouchMove: logOnTouchMove,
    onTouchEnd: logOnTouchEnd,
    onTouchCancel: logOnTouchCancel,
  } = useBottomSheetDismiss(showLog, closeLog);

  const stop = (event: ReactSyntheticEvent) => {
    event.stopPropagation();
  };

  // تشغيل/إيقاف حركة مروررة الصفحة خلف النافذة (حركة صعود وهبوط سلسة خلال 0.4s).
  useEffect(() => {
    if (open) {
      setExiting(false);
      setEntering(true);
      return undefined;
    }
    setEntering(false);
    setExiting(true);
    const timer = window.setTimeout(() => setExiting(false), 400);
    return () => window.clearTimeout(timer);
  }, [open]);

  useEffect(() => {
    if (showLog) {
      setExitingLog(false);
      setEnteringLog(true);
      return undefined;
    }
    setEnteringLog(false);
    setExitingLog(true);
    const timer = window.setTimeout(() => setExitingLog(false), 400);
    return () => window.clearTimeout(timer);
  }, [showLog]);

  // عند إغلاق النافذة الرئيسية، أغلق نافذة السجل تلقائياً ومنع بقائها يتيمة أو
  // محافظة على ظهورها بعد مغادرة الملف الشخصي. تحرك الإغلاق التدريجي يُحفظ
  // لكلا الزجاجتين عبر حالات exiting/exitingLog المنفصلة.
  useEffect(() => {
    if (!open) {
      setShowLog(false);
      setSelectedGift(null);
    }
  }, [open]);

  const refresh = useCallback(async () => {
    if (!open || !supabaseConfigured) return;
    let active = true;
    try {
      setLoading(true);
      const [popResult, balanceResult, countResult, giftsResult] =
        await Promise.all([
          fetchPopularity(userId),
          fetchMyBalance(currentUserId),
          supabase
            .from('gift_transactions')
            .select('*', { head: true, count: 'exact' })
            .eq('recipient_id', userId),
          fetchReceivedGifts({ userId, page: 0 }),
        ]);
      if (!active) return;
      if (typeof popResult === 'number') {
        setPopularity(popResult);
        // مزامنة كبسولة الوسام أعلى الملف الشخصي بالقيمة الحقيقية من الخادم.
        onPopularityChange?.(popResult);
      }
      setBalance(typeof balanceResult === 'number' ? balanceResult : 0);
      setTotalReceived(typeof countResult.count === 'number' ? countResult.count : 0);
      setItems(giftsResult.items);
      setHasMore(giftsResult.hasMore);
      setPage(0);
    } catch (error) {
      console.error('[popularity sheet] تعذر تحديث البيانات:', error);
    } finally {
      if (active) setLoading(false);
    }
  }, [open, userId, currentUserId, onPopularityChange]);

  useEffect(() => {
    if (!open) {
      setSelectedGift(null);
      setAttempt(null);
      return;
    }
    // عند الفتح: إعادة ضبط الحالة وجلب البيانات من المصدر الحقيقي.
    setSelectedGift(null);
    setAttempt(null);
    setShowLog(false);
    setLoading(true);
    setItems([]);
    setHasMore(false);
    void Promise.all([refresh(), fetchCatalog()]).catch(console.error);
    return () => {
      /* تُلغى آثار الطلبات السابقة عند الإغلاق عبر علم `active` داخل `refresh` */
    };
  }, [open, userId, currentUserId, refresh]);

  const fetchCatalog = async () => {
    if (!supabaseConfigured) return;
    setCatalogLoading(true);
    try {
      const rows = await fetchGiftCatalog();
      setCatalog(rows);
    } catch (error) {
      console.error('[popularity sheet] تعذر جلب كتالوج الهدايا:', error);
    } finally {
      setCatalogLoading(false);
    }
  };

  const loadMore = useCallback(async () => {
    if (loadingMore || !hasMore) return;
    setLoadingMore(true);
    try {
      const next = await fetchReceivedGifts({ userId, page: page + 1 });
      setItems(prev => [...prev, ...next.items]);
      setHasMore(next.hasMore);
      setPage(prev => prev + 1);
    } catch (error) {
      console.error('[popularity sheet] تعذر تحميل صفحة إضافية:', error);
    } finally {
      setLoadingMore(false);
    }
  }, [loadingMore, hasMore, userId, page]);

  const toggleGift = (gift: Gift) => {
    // لا يُسمح بتغيير الهدية قبل حسم نتيجة العملية المعلقة.
    if (attempt) return;
    if (gift.price > balance) return;
    setSelectedGift(prev => (prev?.id === gift.id ? null : gift));
  };

  const onRecharge = () => {
    // عملية الشحن معطلة إلى حين تكامل مزود دفع فعّال من جهة الخادم.
    // لا يُضف أي رصيد، ولا يُستدعى أي مسار شحن من واجهة المستخدم.
    toast.info('خدمة شحن الرصيد غير متاحة حالياً.');
  };

  const onEarnFree = () => {
    // لا يوجد مزود إعلانات مكافأة متكامل في المشروع: لا تُمنح عملات وهمية
    // ولا يُ Claim أن مشاهدة إعلان تعمل. قبل تفعيل هذه الميزة، يجب:
    //   1. اختيار مزود إعلانات مكافأة (مثلاً AdMob rewarded ads).
    //   2. إضافة مسار خادم آمن يتحقق من اكتمال مشاهدة الإعلان ويمنع التكرار/التزوير.
    //   3. إضافة دالة RPC تمنح العملات فقط بعد التحقق من جهة الخادم.
    toast.info('خدمة الربح المجاني غير متاحة حالياً.');
  };

  const handleSend = async () => {
    if (!selectedGift || sending || selectedGift.price > balance) return;

    const activeAttempt: SendAttempt = resolveSendAttempt(attempt, {
      recipientId: userId,
      giftId: selectedGift.id,
      generateKey: () =>
        typeof crypto !== 'undefined' && crypto.randomUUID
          ? crypto.randomUUID()
          : `${currentUserId}-${userId}-${selectedGift.id}-${Date.now()}`,
    });
    if (
      attempt &&
      attempt.status === 'inconclusive' &&
      (attempt.recipientId !== activeAttempt.recipientId ||
        attempt.giftId !== activeAttempt.giftId)
    ) {
      // درع: لا نعيد استخدام مفتاح قديم مع مستلم/هدية مختلفين.
      toast.error('لا يمكن تغيير الهدية أو المستلم قبل حسم العملية المعلقة.');
      return;
    }

    setAttempt(activeAttempt);
    try {
      const result: SendGiftResult = await sendGift(
        currentUserId,
        userId,
        selectedGift.id,
        activeAttempt.key
      );
      if (!result.ok) {
        if (result.inconclusive) {
          // نتيجة غير محسومة (نقل/اتصال/مهلة/انقطاع): نُبقي نفس المحاولة والمفتاح
          // ونعرض إعادة المحاولة، دون اعتبارها رفضاً نهائياً.
          setAttempt({ ...activeAttempt, status: 'inconclusive' });
          toast.error(result.error || 'تعذّر تأكيد الإرسال. أعد المحاولة.');
          return;
        }
        // رفض مؤكد من الخادم (رصيد/هدية/صلاحية): العملية محسومة كفشل.
        toast.error(result.error || 'فشل إرسال الهدية.');
        setAttempt(null);
        return;
      }
      // نجاح مؤكد من الخادم: تصفير المحاولة والاختيار وتحديث البيانات من المصدر الحقيقي.
      setSelectedGift(null);
      setAttempt(null);
      if (typeof result.balance === 'number') setBalance(result.balance);
      await refresh();
      toast.success(
        result.duplicate
          ? 'تم استلام الطلب (مكرر، لم يُخصم رصيد إضافي).'
          : 'تم إرسال الهدية بنجاح.'
      );
    } catch (error) {
      // خطأ غير متوقع (نقل/شبكة): نتيجة غير محسومة، نُبقي المفتاح ونقفل الاختيار
      // لإعادة المحاولة بنفس العملية دون خصم مزدوج.
      console.error('[popularity sheet] تعذر الإرسال:', error);
      setAttempt({ ...activeAttempt, status: 'inconclusive' });
      toast.error(error instanceof Error ? error.message : 'تعذّر الإرسال. أعد المحاولة.');
    }
  };

  // فتحات الشبكة الستة (ثلاثة أعمدة وصفّان). تُملأ من كتالوج قاعدة البيانات
  // حسب الترتيب (السعر تصاعدياً)، وتُترك خانات فارغة إن كانت أقل من ستة.
  const giftSlots = Array.from({ length: 6 }, (_, index) => catalog[index] ?? null);

  const panelEnterStyle = {
    transform: open
      ? dragging
        ? `translate3d(0, ${dragOffset}px, 0)`
        : 'translate3d(0, 0, 0)'
      : 'translate3d(0, 100%, 0)',
    transition: dragging ? 'none' : `transform 0.4s cubic-bezier(0.24, 1, 0.32, 1), opacity 0.4s ease`,
    opacity: open ? 1 : 0,
  } as React.CSSProperties;

  const backdropStyle = {
    opacity: open ? (entering ? 1 : 0) : 0,
    transition: `opacity 0.4s ease`,
  } as React.CSSProperties;

  const logPanelEnterStyle = {
    transform: showLog
      ? logDragging
        ? `translate3d(0, ${logDragOffset}px, 0)`
        : 'translate3d(0, 0, 0)'
      : 'translate3d(0, 100%, 0)',
    transition: logDragging ? 'none' : `transform 0.4s cubic-bezier(0.24, 1, 0.32, 1), opacity 0.4s ease`,
    opacity: showLog ? 1 : 0,
  } as React.CSSProperties;

  const logBackdropStyle = {
    opacity: showLog ? (enteringLog ? 1 : 0) : 0,
    transition: `opacity 0.4s ease`,
  } as React.CSSProperties;

  const sheetRoot = (
    <div
      className={cn('popularity-sheet-overlay fixed inset-0 z-[2000]', !open ? 'pointer-events-none' : undefined)}
      dir="rtl"
      role="dialog"
      aria-modal="true"
      aria-label="وسم الشعبية"
      onPointerDown={stop}
      onPointerMove={stop}
      onPointerUp={stop}
      onPointerCancel={stop}
      onTouchStart={stop}
      onTouchMove={stop}
      onTouchEnd={stop}
      onTouchCancel={stop}
      style={backdropStyle}
    >
      {/* طبقة خلفية معتمة عند فتح النافذة */}
      <div
        className="absolute inset-0 bg-black/60"
        onClick={onClose}
      />

      <section
        className="popularity-sheet-panel fixed left-0 right-0 bottom-0 z-[2010] h-[68dvh] max-h-[68dvh] rounded-t-[24px] bg-[#121214] overflow-hidden flex flex-col shadow-2xl"
        style={panelEnterStyle}
        onClick={stop}
        onPointerDown={stop}
        onPointerMove={stop}
        onPointerUp={stop}
        onPointerCancel={stop}
        onTouchStart={stop}
        onTouchMove={stop}
        onTouchEnd={stop}
        onTouchCancel={stop}
      >
        {/* مقبض السحب في المنتصف */}
        <div
          className="popularity-sheet-handle-area flex justify-center pt-1 pb-1"
          onClickCapture={onClickCapture}
          onPointerDown={event => {
            event.stopPropagation();
            onPointerDown(event);
          }}
          onTouchStart={event => {
            event.stopPropagation();
            onTouchStart(event);
          }}
          onTouchMove={event => {
            event.stopPropagation();
            onTouchMove(event);
          }}
          onTouchEnd={event => {
            event.stopPropagation();
            onTouchEnd(event);
          }}
          onTouchCancel={event => {
            event.stopPropagation();
            onTouchCancel();
          }}
        >
          <span className="popularity-sheet-handle-bar w-12 h-1.5 rounded-full bg-zinc-600" aria-hidden="true" />
        </div>

        {/* رأس النافذة: زر إغلاق في أقصى اليسار وعنوان مركزي */}
        <header className="relative flex shrink-0 items-center px-4 py-3">
          <button
            type="button"
            onClick={onClose}
            className="absolute left-4 top-1/2 -translate-y-1/2 z-20 rounded-full p-1.5 text-zinc-400 transition hover:bg-[#2A2A2E] hover:text-white"
            aria-label="إغلاق وسم الشعبية"
          >
            <X size={20} />
          </button>
          <h2 className="flex-1 text-center text-lg font-bold text-white">وسم الشعبية</h2>
        </header>

        <div className="flex-1 overflow-y-auto px-4 space-y-4 pb-[env(safe-area-inset-bottom)] pt-1">
          {/* ===== شريط الإعلان ===== */}
          <div className="w-full flex justify-center">
            <div
              className="relative w-full border border-[#3A3A3E] bg-gradient-to-r from-[#1A1A1E] to-[#2A2A2E] rounded-[25px] h-[50px]"
            >
              <span className="absolute left-1/2 -translate-x-1/2 text-xs font-medium text-zinc-200">
                مساحة إعلانية
              </span>
              <span className="absolute right-3 top-1/2 -translate-y-1/2 rounded-full bg-[#DC2626] px-2 py-0.5 text-[10px] font-bold text-white">
                إعلان
              </span>
            </div>
          </div>

          {/* ===== بطاقة وسم الشعبية ===== */}
          <div className="rounded-xl border border-[#333] bg-[#101012] p-3">
            <div className="flex flex-row justify-between gap-2">
              <h3 className="text-right text-xs font-semibold text-zinc-400">
                إجمالي وسم الشعبية
              </h3>
              <button
                type="button"
                disabled={sending || showLog}
                onClick={() => setShowLog(true)}
                className="rounded-lg border border-[#3A3A3E] bg-[#1A1A1E] px-3 py-1.5 text-xs font-semibold text-white transition disabled:opacity-50 hover:bg-[#2A2A2E]"
                aria-label="فتح سجل وسم الشعبية"
              >
                السجل
              </button>
            </div>
            <div className="mt-1 text-right">
              <span className="text-3xl font-black text-white tabular-nums">
                {formatPopularity(popularity)}
              </span>
              <p className="text-xs text-zinc-500">
                {totalReceived} هدية مستلمة
              </p>
            </div>
          </div>

          {/* ===== صف أزرار الشحن والربح المجاني ===== */}
          <div className="flex gap-2">
            {/* زر الشحن على اليمين (بداية الصف في اتجاه RTL) */}
            <button
              type="button"
              disabled={sending}
              onClick={onRecharge}
              style={{ background: 'linear-gradient(135deg, #F59E0B, #D97706)' }}
              className="flex flex-col items-center gap-1 justify-center rounded-lg px-3 py-2 text-white font-semibold shadow-sm disabled:opacity-50 disabled:cursor-not-allowed"
            >
              <div className="flex items-center gap-1.5">
                <span className="w-5 h-5 rounded bg-white flex items-center justify-center">
                  <Plus size={10} className="text-[#F59E0B]" />
                </span>
                <span className="text-sm leading-none">شحن</span>
              </div>
              {balance > 0 && (
                <span className="text-[11px] leading-none text-[#FDE6A2]">
                  رصيدك: {balance} عملة
                </span>
              )}
            </button>

            {/* زر الربح المجاني على اليسار */}
            <button
              type="button"
              disabled={sending}
              onClick={onEarnFree}
              className="flex items-center gap-2 rounded-lg border border-[#3A3A3E] bg-[#1A1A1E] px-3 py-2 text-sm font-semibold disabled:opacity-50 disabled:cursor-not-allowed"
            >
              <span className="text-lg">🎬</span>
              <span className={`font-bold ${GREEN_COLOR}`}>اكسب مجاناً</span>
            </button>
          </div>

          {/* ===== شبكة الهدايا ===== */}
          <p className="text-xs text-zinc-500 text-right">
            اختر هدية لإرسالها (الهدايا غير المتاحة لرصيدك لا يمكن اختيارها)
          </p>
          <div className="grid grid-cols-3 gap-[8px]">
            {catalogLoading ? (
              <ListSkeleton count={6} compact className="px-1" />
            ) : (
              giftSlots.map((gift, index) => {
                if (!gift) {
                  return (
                    <div
                      key={index}
                      className="rounded-xl border border-[#222]/40 bg-[#0B0C0E]/60 p-1.5"
                    />
                  );
                }
                const unaffordable = gift.price > balance;
                const selected = selectedGift?.id === gift.id;
                return (
                  <button
                    key={gift.id}
                    type="button"
                    disabled={unaffordable || attempt !== null}
                    onClick={() => toggleGift(gift)}
                    aria-pressed={selected ? 'true' : 'false'}
                    className={cn(
                      'flex flex-col items-center gap-1.5 p-1.5 rounded-xl border transition duration-200',
                      selected
                        ? `bg-[#F472B6]/10 border-[#F472B6]/60`
                        : unaffordable
                          ? 'border-transparent opacity-50 bg-[#0B0C0E]/40'
                          : 'border-transparent hover:border-[#3A3A3E]/60 hover:bg-[#151517]/60'
                    )}
                  >
                    <div className="h-6 w-6 shrink-0 rounded-sm flex items-center justify-center overflow-hidden bg-[#0B0C0E]">
                      {gift.image_url ? (
                        <SignedImage
                          src={gift.image_url}
                          className="h-full w-full object-cover"
                          alt=""
                        />
                      ) : (
                        <span className="text-lg" aria-hidden="true">
                          {giftEmoji(gift.name)}
                        </span>
                      )}
                    </div>
                    <span className="text-xs font-semibold text-white line-clamp-1 text-center leading-snug">
                      {gift.name}
                    </span>
                    <span className="text-xs font-semibold text-center text-[#FBBF24]">
                      {gift.price}
                    </span>
                  </button>
                );
              })
            )}
          </div>

          {/* ملخص الهدية المختارة */}
          {selectedGift && !sending && (
            <div className="rounded-xl border border-[#3A3A3E] bg-[#121214]/80 p-2 text-right space-x-2">
              <span className="text-sm font-semibold text-white truncate">
                {selectedGift.name}
              </span>
              <span className="text-xs text-[#FBBF24] font-semibold">
                السعر {selectedGift.price} 🪙
              </span>
              <span className="text-xs text-zinc-500">
                {selectedGift.popularity_points} نقطة شعبية للمستلم
              </span>
            </div>
          )}

          {/* ===== زر إرسال الهدية ===== */}
          <button
            type="button"
            disabled={!selectedGift || sending || selectedGift.price > balance}
            onClick={handleSend}
            style={{ background: 'linear-gradient(135deg, #E11D48, #BE123C)' }}
            className="w-full rounded-xl py-3 text-sm font-bold text-white shadow-lg disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {!selectedGift ? (
              'اختر هدية للإرسال'
            ) : sending ? (
              <>
                <svg
                  className="w-4 h-4 mr-1.5 animate-spin"
                  xmlns="http://www.w3.org/2000/svg"
                  fill="none"
                  viewBox="0 0 24 24"
                  aria-hidden="true"
                >
                  <circle
                    className="opacity-25"
                    cx="12"
                    cy="12"
                    r="10"
                    stroke="currentColor"
                    strokeWidth="4"
                  ></circle>
                  <path
                    className="opacity-75"
                    fill="currentColor"
                    d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
                  ></path>
                </svg>
                جارٍ الإرسال…
              </>
            ) : attempt?.status === 'inconclusive' ? (
              'إعادة المحاولة'
            ) : (
              `إرسال هدية (السعر ${selectedGift.price} 🪙)`
            )}
          </button>
        </div>
      </section>
    </div>
  );

  // نافذة السجل الثانية (فوق النافذة الرئيسية، مستوى ظهور أعلى)
  const logRoot = (
    <div
      className={cn('popularity-sheet-overlay fixed inset-0 z-[2060]', !showLog ? 'pointer-events-none' : undefined)}
      dir="rtl"
      role="dialog"
      aria-modal="true"
      aria-label="سجل وسم الشعبية"
      onPointerDown={stop}
      onPointerMove={stop}
      onPointerUp={stop}
      onPointerCancel={stop}
      onTouchStart={stop}
      onTouchMove={stop}
      onTouchEnd={stop}
      onTouchCancel={stop}
      style={logBackdropStyle}
    >
      <div
        className="absolute inset-0 bg-black/60"
        onClick={closeLog}
      />

      <section
        className="popularity-sheet-panel fixed left-0 right-0 bottom-0 z-[2070] h-[68dvh] max-h-[68dvh] rounded-t-[24px] bg-[#121214] overflow-hidden flex flex-col shadow-2xl"
        style={logPanelEnterStyle}
        onClick={stop}
        onPointerDown={stop}
        onPointerMove={stop}
        onPointerUp={stop}
        onPointerCancel={stop}
        onTouchStart={stop}
        onTouchMove={stop}
        onTouchEnd={stop}
        onTouchCancel={stop}
      >
        <div
          className="popularity-sheet-handle-area flex justify-center pt-1 pb-1"
          onClickCapture={logOnClickCapture}
          onPointerDown={event => {
            event.stopPropagation();
            logOnPointerDown(event);
          }}
          onTouchStart={event => {
            event.stopPropagation();
            logOnTouchStart(event);
          }}
          onTouchMove={event => {
            event.stopPropagation();
            logOnTouchMove(event);
          }}
          onTouchEnd={event => {
            event.stopPropagation();
            logOnTouchEnd(event);
          }}
          onTouchCancel={event => {
            event.stopPropagation();
            logOnTouchCancel();
          }}
        >
          <span className="popularity-sheet-handle-bar w-12 h-1.5 rounded-full bg-zinc-600" aria-hidden="true" />
        </div>

        <header className="relative flex shrink-0 items-center px-4 py-3">
          <button
            type="button"
            onClick={closeLog}
            className="absolute left-4 top-1/2 -translate-y-1/2 z-20 rounded-full p-1.5 text-zinc-400 transition hover:bg-[#2A2A2E] hover:text-white"
            aria-label="إغلاق سجل وسم الشعبية"
          >
            <X size={20} />
          </button>
          <h2 className="flex-1 text-center text-lg font-bold text-white">
            سجل وسم الشعبية
          </h2>
        </header>

        <div className="flex-1 overflow-y-auto px-3 space-y-2 pb-[env(safe-area-inset-bottom)] pt-1">
          {loading ? (
            <ListSkeleton count={5} compact className="px-1" />
          ) : items.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-10 text-center">
              <p className="text-sm text-zinc-500">
                لا توجد هدايا مستلمة في سجل وسم الشعبية بعد.
              </p>
            </div>
          ) : (
            <ul className="space-y-1">
              {items.map(item => {
                const gift = item.gift;
                const sender = item.sender;
                return (
                  <li
                    key={item.id}
                    className="flex items-center gap-2 rounded-lg border border-transparent p-2 hover:border-[#3A3A3E]/60 transition"
                  >
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-semibold text-white text-right truncate">
                        {sender ? displayName(sender) : 'مُرسل'}
                      </p>
                      <p className="text-xs text-zinc-400 text-right">
                        {gift ? `${gift.name} · ${gift.popularity_points} نقطة شعبية` : 'هدية'}
                      </p>
                    </div>
                    <p className="text-xs text-zinc-500 shrink-0 text-left">
                      {formatDate(item.created_at)}
                    </p>
                    <div className="shrink-0">
                      {gift?.image_url ? (
                        <SignedImage
                          src={gift.image_url}
                          className="h-8 w-8 rounded-md object-cover"
                          alt=""
                        />
                      ) : (
                        <div className="h-8 w-8 rounded-md bg-[#151517] flex items-center justify-center text-lg border border-[#2A2A2E]">
                          {giftEmoji(gift?.name ?? '')}
                        </div>
                      )}
                    </div>
                  </li>
                );
              })}
            </ul>
          )}

          {hasMore && (
            <button
              type="button"
              onClick={loadMore}
              disabled={loadingMore}
              className="w-full rounded-xl border border-[#3A3A3E] bg-[#1A1A1E] px-3 py-2 text-sm text-right transition disabled:opacity-60 hover:bg-[#1A1A1E]/80"
            >
              {loadingMore ? 'جارٍ التحميل…' : 'تحميل المزيد'}
            </button>
          )}
        </div>
      </section>
    </div>
  );

  if (!open && !exiting && !showLog && !exitingLog) return null;

  return createPortal(
    <>
      {(!open && !exiting) ? null : sheetRoot}
      {(showLog || exitingLog) ? logRoot : null}
    </>,
    document.body
  );
}
