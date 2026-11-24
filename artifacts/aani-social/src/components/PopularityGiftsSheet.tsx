import {
  useCallback,
  useEffect,
  useState,
  type PointerEvent as ReactPointerEvent,
  type TouchEvent as ReactTouchEvent,
} from 'react';
import { createPortal } from 'react-dom';
import { ChevronRight, X } from 'lucide-react';

import Avatar from '@/components/Avatar';
import { ListSkeleton } from '@/components/Skeletons';
import EmptyState from '@/components/EmptyState';
import { SignedImage } from '@/components/SignedMedia';
import { useBottomSheetDismiss } from '@/hooks/useBottomSheetDismiss';
import { useOverlayBack } from '@/hooks/useOverlayBack';
import { supabase, supabaseConfigured } from '@/lib/supabase';
import {
  displayName,
  formatDate,
  formatPopularity,
  fetchGiftCatalog,
  fetchMyBalance,
  fetchPopularity,
  fetchReceivedGifts,
  sendGift,
  type Gift,
  type ReceivedGift,
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

const MEDAL_SVG = (
  <svg
    viewBox="0 0 24 24"
    className="w-5 h-5 shrink-0 text-white"
    fill="none"
    xmlns="http://www.w3.org/2000/svg"
    aria-hidden="true"
  >
    <path d="M6 2H9V8.2L12 10.1L6 6.2V2Z" fill="#FFFFFF" fillOpacity="0.65" />
    <path d="M18 2H15V8.2L12 10.1L18 6.2V2Z" fill="#FFFFFF" fillOpacity="0.65" />
    <path d="M9.6 2H14.4V8.5L12 10.1L9.6 8.5V2Z" fill="#FFFFFF" />
    <path
      fillRule="evenodd"
      d="M12 11.2A5.3 5.3 0 1 0 12 21.8A5.3 5.3 0 1 0 12 11.2ZM12.00 13.30L12.76 15.43L15.02 15.50L13.23 16.88L13.87 19.05L12.00 17.78L10.13 19.05L10.77 16.88L8.98 15.50L11.24 15.43Z"
      fill="#FFFFFF"
    />
  </svg>
);

export default function PopularityGiftsSheet({
  open,
  userId,
  recipientName,
  currentUserId,
  onClose,
  onPopularityChange,
}: PopularityGiftsSheetProps) {
  useOverlayBack(open, onClose);
  const [step, setStep] = useState<'summary' | 'choose'>('summary');
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
  const [sending, setSending] = useState(false);
  const [recipientLabel, setRecipientLabel] = useState(recipientName || '');
  const [sendKey, setSendKey] = useState<string | null>(null);

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

  const stop = (event: ReactPointerEvent | ReactTouchEvent) => {
    event.stopPropagation();
  };

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
      if (typeof popResult === 'number') setPopularity(popResult);
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
  }, [open, userId, currentUserId]);

  useEffect(() => {
    if (!open) {
      setStep('summary');
      setSelectedGift(null);
      return;
    }
    setLoading(true);
    setItems([]);
    setHasMore(false);
    void Promise.all([refresh(), fetchCatalog()]).catch(console.error);
    return () => {
      /* تُلغى آثار الطلبات السابقة عند الإغلاق/التنقل بين الملفات عبر علم `active` داخل `refresh` */
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
    if (gift.price > balance) return;
    setSelectedGift(prev => (prev?.id === gift.id ? null : gift));
  };

  const handleSend = async () => {
    if (!selectedGift || sending || selectedGift.price > balance) return;
    try {
      const key = sendKey ?? ((typeof crypto !== "undefined" && crypto.randomUUID) ? crypto.randomUUID() : (currentUserId + "-" + userId + "-" + selectedGift.id + "-" + Date.now()));
    if (!sendKey) setSendKey(key);
    setSending(true);
    try {
      const result: SendGiftResult = await sendGift(currentUserId, userId, selectedGift.id, key);
      if (!result.ok) {
        toast.error(result.error || 'فشل إرسال الهدية.');
        return;
      }
      setSelectedGift(null);
      setStep('summary');
      setSendKey(null);
      if (typeof result.balance === 'number') setBalance(result.balance);
      await refresh();
      if (typeof result.popularity_points === 'number') {
        const nextPopularity = popularity + result.popularity_points;
        setPopularity(nextPopularity);
        onPopularityChange?.(nextPopularity);
      }
      toast.success(result.duplicate
        ? 'تم استلام الطلب (مكرر، لم يُخصم رصيد إضافي).'
        : 'تم إرسال الهدية بنجاح.');
    } catch (error) {
      console.error('[popularity sheet] تعذر الإرسال:', error);
      toast.error(error instanceof Error ? error.message : 'فشل إرسال الهدية.');
    } finally {
      setSending(false);
    }
  };

  if (!open) return null;

  return createPortal(
    <div
      className="popularity-sheet-overlay fixed inset-0 z-[2000] flex items-end justify-center"
      dir="rtl"
      role="dialog"
      aria-modal="true"
      aria-label="الشعبية والهدايا"
      onPointerDown={stop}
      onPointerMove={stop}
      onPointerUp={stop}
      onPointerCancel={stop}
      onTouchStart={stop}
      onTouchMove={stop}
      onTouchEnd={stop}
      onTouchCancel={stop}
    >
      <div className="absolute inset-0" onClick={onClose} />

      <section
        aria-label="الشعبية والهدايا"
        className="popularity-sheet-panel relative z-10 flex w-full flex-col text-white"
        style={{
          transform: dragOffset > 0 ? `translate3d(0, ${dragOffset}px, 0)` : undefined,
          transition: dragging ? 'none' : undefined,
        }}
        onClick={stop}
      >
        <div
          className="popularity-sheet-handle-area"
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
          <span className="popularity-sheet-handle-bar" aria-hidden="true" />
        </div>

        {/* ===== العرض الأول: الشعبية والهدايا المستلمة ===== */}
        {step === 'summary' && (
          <>
            <header className="comments-sheet-header flex shrink-0 items-center justify-between px-4 py-3">
              <button
                type="button"
                onClick={onClose}
                className="rounded-full p-1.5 text-zinc-400 transition hover:bg-zinc-800 hover:text-white"
                aria-label="إغلاق الشعبية والهدايا"
              >
                <X size={20} />
              </button>
              <h2 className="text-base font-bold text-zinc-100">الشعبية والهدايا</h2>
              <div className="w-8" />
            </header>

            <div className="min-h-0 flex-1 overflow-y-auto px-4 py-2 space-y-4">
              <div className="rounded-xl border border-[#2F3336] bg-[#0a0a0a] p-4">
                <div className="flex flex-col-reverse sm:flex-row sm:items-center sm:justify-between gap-3 text-right sm:text-left">
                  <div>
                    <p className="text-xs text-zinc-400">إجمالي الشعبية</p>
                    <div className="flex items-baseline gap-1">
                      <span className="text-3xl font-black text-white tabular-nums">
                        {formatPopularity(popularity)}
                      </span>
                    </div>
                  </div>
                  <div className="flex items-center gap-2">{MEDAL_SVG}</div>
                </div>
                <p className="mt-2 text-xs text-zinc-400 text-right">
                  إجمالي الهدايا المستلمة: <span className="text-white font-semibold">{totalReceived}</span>
                </p>
              </div>

              {loading ? (
                <ListSkeleton count={5} compact className="px-1" />
              ) : items.length === 0 ? (
                <EmptyState className="py-6" />
              ) : (
                <ul className="space-y-2">
                  {items.map(item => {
                    const gift = item.gift;
                    const sender = item.sender;
                    return (
                      <li
                        key={item.id}
                        className="flex min-w-0 flex-row items-center gap-3 rounded-xl border border-white/5 px-3 py-2.5"
                      >
                        <div className="shrink-0">
                          {sender ? (
                            <Avatar profile={sender} />
                          ) : (
                            <div className="h-10 w-10 rounded-full bg-neutral-800 flex items-center justify-center text-sm">
                              ?
                            </div>
                          )}
                        </div>
                        <div className="min-w-0 flex-1">
                          {gift ? (
                            <div className="flex flex-wrap items-center gap-1.5 text-sm font-semibold text-white">
                              {gift.name}
                              <span className="text-xs text-zinc-400">· {gift.popularity_points} نقطة شعبية</span>
                            </div>
                          ) : (
                            <p className="text-sm font-semibold text-white">هدية</p>
                          )}
                          {sender ? (
                            <p className="text-xs text-zinc-400 truncate">
                              من {displayName(sender)}
                            </p>
                          ) : null}
                          <p className="text-xs text-zinc-500">{formatDate(item.created_at)}</p>
                        </div>
                        <div className="shrink-0">
                          {gift?.image_url ? (
                            <SignedImage
                              src={gift.image_url}
                              className="h-10 w-10 rounded-md object-cover"
                              alt=""
                            />
                          ) : (
                            <div className="h-10 w-10 rounded-md bg-neutral-800 flex items-center justify-center text-xl">
                              🎁
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
                  className="w-full rounded-xl border border-[#2F3336] bg-white/5 px-3 py-2 text-sm text-right transition hover:bg-white/10 disabled:opacity-60"
                >
                  {loadingMore ? 'جارٍ التحميل…' : 'تحميل المزيد'}
                </button>
              )}

              <button
                type="button"
                onClick={() => setStep('choose')}
                disabled={sending}
                className="w-full rounded-xl bg-white px-4 py-3 text-sm font-bold text-black transition hover:bg-neutral-100 disabled:opacity-60"
              >
                إرسال هدية
              </button>
            </div>
          </>
        )}

        {/* ===== العرض الثاني: اختيار الهدية للإرسال ===== */}
        {step === 'choose' && (
          <>
            <header className="comments-sheet-header flex shrink-0 items-center justify-between px-4 py-3">
              <h2 className="text-base font-bold text-zinc-100">اختيار هدية</h2>
              <button
                type="button"
                onClick={() => setStep('summary')}
                className="rounded-full p-1.5 text-zinc-400 transition hover:bg-zinc-800 hover:text-white"
                aria-label="العودة"
              >
                <ChevronRight size={20} />
              </button>
            </header>

            <div className="min-h-0 flex-1 overflow-y-auto px-4 py-2 space-y-4">
              <div className="rounded-xl border border-[#2F3336] bg-[#0a0a0a] p-3 text-right">
                <p className="text-xs text-zinc-400">المستلم</p>
                <p className="text-sm font-semibold text-white truncate">
                  {recipientLabel || 'المستخدم'}
                </p>
                <p className="mt-1 text-xs text-zinc-400">رصيدك: <span className="text-white font-semibold tabular-nums">{balance}</span> عملة</p>
              </div>

              {catalogLoading ? (
                <ListSkeleton count={6} compact className="px-1" />
              ) : catalog.length === 0 ? (
                <EmptyState className="py-6" />
              ) : (
                <>
                  <p className="text-xs text-zinc-500 text-right">
                    اختر هدية (الهدايا غير المتاحة لرصيدك لا يمكن إرسالها)
                  </p>
                  <div className="grid grid-cols-3 sm:grid-cols-4 gap-3">
                    {catalog.map(gift => (
                      <button
                        key={gift.id}
                        type="button"
                        disabled={gift.price > balance}
                        onClick={() => toggleGift(gift)}
                        className={`
                          flex flex-col items-center gap-2 rounded-xl p-3 border transition
                          ${selectedGift?.id === gift.id
                            ? 'ring-2 ring-white bg-white/5 border-white/30'
                            : 'border-transparent hover:bg-white/5'}
                          ${gift.price > balance ? 'opacity-60' : ''}
                        `}
                        aria-pressed={selectedGift?.id === gift.id ? 'true' : 'false'}
                      >
                        <div className="h-12 w-12 rounded-md flex items-center justify-center overflow-hidden bg-[#0a0a0a]">
                          {gift.image_url ? (
                            <SignedImage src={gift.image_url} className="h-full w-full object-cover" alt="" />
                          ) : (
                            <span className="text-xl">🎁</span>
                          )}
                        </div>
                        <span className="text-xs font-semibold text-white line-clamp-1 text-center">
                          {gift.name}
                        </span>
                        <span className="text-xs text-zinc-400 text-center">سعر {gift.price}</span>
                      </button>
                    ))}
                  </div>
                </>
              )}

              {selectedGift && (
                <div className="rounded-xl border border-[#2F3336] bg-[#0a0a0a] p-3 text-right space-y-2">
                  <div className="flex flex-wrap items-center gap-2 text-sm font-semibold text-white">
                    {selectedGift.name}
                    <span className="text-xs text-zinc-400">· {selectedGift.popularity_points} نقطة شعبية للمستلم</span>
                  </div>
                  <p className="text-xs text-zinc-400">السعر: <span className="text-white">{selectedGift.price}</span> عملة</p>
                  <p className="text-xs text-zinc-400">
                    رصيدك بعد الإرسال:{' '}
                    <span className={balance >= selectedGift.price ? 'text-green-400' : 'text-red-400'} font-semibold tabular-nums>
                      {balance - selectedGift.price}
                    </span>
                    عملة
                  </p>
                  <button
                    type="button"
                    disabled={sending || selectedGift.price > balance}
                    onClick={handleSend}
                    className="w-full rounded-full bg-white px-4 py-2 text-sm font-bold text-black transition disabled:opacity-60 disabled:cursor-not-allowed hover:bg-neutral-100"
                  >
                    {sending ? 'جارٍ الإرسال…' : 'تأكيد الإرسال'}
                  </button>
                </div>
              )}
            </div>
          </>
        )}
      </section>
    </div>,
    document.body
  );
}
