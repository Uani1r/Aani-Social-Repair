import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  Check,
  Ghost,
  Instagram,
  Link2,
  Loader2,
  Mail,
  MessageCircle,
  MessageSquare,
  Repeat2,
  Search,
  Send,
  Share2,
  X,
} from 'lucide-react';
import { toast } from 'sonner';

import { supabase, supabaseConfigured } from '../lib/supabase';
import { postShareText, postShareUrl } from '../lib/interactions';
import { displayName, type Post, type Profile } from '../lib/types';

interface ShareSheetProps {
  post: Post;
  currentUserId: string;
  reposted?: boolean;
  onToggleRepost?: () => void | Promise<void>;
  onRecordExternalShare?: () => void;
  onSent?: (count: number) => void;
  onClose: () => void;
}

/**
 * نافذة المشاركة السفلية بنمط TikTok:
 * تُعرض عبر React Portal مثبتة أسفل الشاشة (لا تتحرك مع سكرول المنشور)،
 * وتضم: إرسال خاص للمتابَعين/المتابِعين، إعادة نشر، ومشاركة خارجية حقيقية.
 */
const ShareSheet: React.FC<ShareSheetProps> = ({
  post,
  currentUserId,
  reposted = false,
  onToggleRepost,
  onRecordExternalShare,
  onSent,
  onClose,
}) => {
  const [shown, setShown] = useState(false);
  const [users, setUsers] = useState<Profile[]>([]);
  const [loadingUsers, setLoadingUsers] = useState(true);
  const [term, setTerm] = useState('');
  const [searchOpen, setSearchOpen] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [sending, setSending] = useState(false);
  const [note, setNote] = useState('');
  const [repostBusy, setRepostBusy] = useState(false);
  const [myName, setMyName] = useState('');
  const touchStartY = useRef<number | null>(null);
  const sendingRef = useRef(false);

  const close = useCallback(() => {
    setShown(false);
    window.setTimeout(onClose, 180);
  }, [onClose]);

  useEffect(() => {
    const raf = requestAnimationFrame(() => setShown(true));
    return () => cancelAnimationFrame(raf);
  }, []);

  // قفل تمرير الصفحة خلف النافذة
  useEffect(() => {
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = previous;
    };
  }, []);

  // مفتاح Escape يغلق النافذة
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') close();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [close]);

  // قائمة الإرسال: المتابَعون والمتابِعون فقط (من جدول follows) — بدون مستخدمين عشوائيين
  useEffect(() => {
    if (!supabaseConfigured) {
      setLoadingUsers(false);
      return;
    }

    let active = true;
    setLoadingUsers(true);

    const timer = window.setTimeout(async () => {
      try {
        const { data: relations, error: relationError } = await supabase
          .from('follows')
          .select('follower_id, following_id')
          .or(`follower_id.eq.${currentUserId},following_id.eq.${currentUserId}`)
          .limit(2000);

        const ids = new Set<string>();
        if (!relationError) {
          (relations || []).forEach((row: { follower_id: string; following_id: string }) => {
            if (row.follower_id === currentUserId) ids.add(row.following_id);
            else if (row.following_id === currentUserId) ids.add(row.follower_id);
          });
        }
        ids.delete(currentUserId);

        if (ids.size === 0) {
          if (active) {
            setUsers([]);
            setLoadingUsers(false);
          }
          return;
        }

        const { data } = await supabase
          .from('profiles')
          .select('id, username, full_name, avatar_url')
          .in('id', Array.from(ids))
          .limit(500);

        const needle = term.trim().toLowerCase();
        const list = ((data || []) as Profile[]).filter(profile => {
          if (!needle) return true;
          return (
            String(profile.full_name || '').toLowerCase().includes(needle) ||
            String(profile.username || '').toLowerCase().includes(needle)
          );
        });

        list.sort((a, b) => displayName(a).localeCompare(displayName(b), 'ar'));

        if (active) {
          setUsers(list);
          setLoadingUsers(false);
        }
      } catch (error) {
        console.error('Error loading share recipients:', error);
        if (active) {
          setUsers([]);
          setLoadingUsers(false);
        }
      }
    }, 220);

    return () => {
      active = false;
      window.clearTimeout(timer);
    };
  }, [term, currentUserId]);

  // اسم المستخدم الحالي لإشعار إعادة النشر
  useEffect(() => {
    if (!supabaseConfigured) return;

    void supabase
      .from('profiles')
      .select('full_name, username')
      .eq('id', currentUserId)
      .maybeSingle()
      .then(({ data }) => {
        if (data) setMyName(String(data.full_name || data.username || 'مستخدم'));
      });
  }, [currentUserId]);

  const toggleSelect = (id: string) => {
    setSelected(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const shareUrl = useMemo(() => postShareUrl(post.id), [post.id]);
  const shareText = useMemo(() => postShareText(post), [post]);
  const encodedUrl = encodeURIComponent(shareUrl);
  const encodedText = encodeURIComponent(shareText);

  const sendToSelected = async () => {
    if (sendingRef.current || selected.size === 0) return;

    if (!supabaseConfigured) {
      toast.error('تعذر الإرسال: لا يوجد اتصال بقاعدة البيانات');
      return;
    }

    sendingRef.current = true;
    setSending(true);

    const recipients = Array.from(selected);
    const cleanNote = note.trim().slice(0, 500);
    const content = `[post:${post.id}]${cleanNote ? ` ${cleanNote}` : ''}`;

    try {
      const results = await Promise.all(
        recipients.map(async recipientId => {
          const payload = {
            sender_id: currentUserId,
            recipient_id: recipientId,
            content,
            post_id: post.id,
          };

          const first = await supabase.from('messages').insert(payload);
          if (!first.error) return true;

          const code = (first.error as { code?: string }).code;
          if (code === '42703' || /post_id/i.test(first.error.message || '')) {
            // العمود غير موجود بعد في هذه القاعدة: نرسل الرسالة بدون مرجع المنشور
            const legacy: Record<string, unknown> = { ...payload };
            delete legacy.post_id;
            const second = await supabase.from('messages').insert(legacy);
            return !second.error;
          }

          console.error('[share] تعذر إرسال الرسالة الخاصة:', first.error);
          return false;
        }),
      );

      const ok = results.filter(Boolean).length;

      if (ok === 0) {
        toast.error('تعذر إرسال المنشور. تحقق من الاتصال وحاول مجدداً.');
        return;
      }

      toast.success(
        ok === 1 ? 'تم إرسال المنشور' : `تم إرسال المنشور إلى ${ok} أشخاص`,
      );
      onSent?.(ok);
      setSelected(new Set());
      setNote('');
      close();
    } catch (error) {
      console.error('[share] خطأ أثناء الإرسال:', error);
      toast.error('تعذر إرسال المنشور. حاول مرة أخرى.');
    } finally {
      sendingRef.current = false;
      setSending(false);
    }
  };

  const copyLink = async () => {
    try {
      await navigator.clipboard.writeText(shareUrl);
      toast.success('تم نسخ رابط المنشور');
      onRecordExternalShare?.();
    } catch {
      toast.error('تعذر نسخ الرابط');
    }
  };

  const openExternal = (url: string) => {
    const win = window.open(url, '_blank', 'noopener,noreferrer');
    if (!win) window.location.href = url;
    onRecordExternalShare?.();
  };

  const nativeShare = async () => {
    if (navigator.share) {
      try {
        await navigator.share({ title: 'منشور على آني', text: shareText, url: shareUrl });
        onRecordExternalShare?.();
      } catch {
        /* ألغى المستخدم المشاركة */
      }
    } else {
      void copyLink();
    }
  };

  // إنستغرام لا يوفّر رابط مشاركة ويب عاماً: نمرّر عبر مشاركة النظام، وإلا ننسخ الرابط
  const shareToInstagram = async () => {
    if (navigator.share) {
      try {
        await navigator.share({ title: 'منشور على آني', text: shareText, url: shareUrl });
        onRecordExternalShare?.();
        return;
      } catch {
        return;
      }
    }
    await copyLink();
  };

  const handleRepost = async () => {
    if (repostBusy || !onToggleRepost) return;

    setRepostBusy(true);
    try {
      await onToggleRepost();

      const wasReposting = !reposted;

      if (wasReposting) {
        if (supabaseConfigured) {
          try {
            const cleanNote = note.trim().slice(0, 200);
            if (cleanNote) {
              await supabase
                .from('reposts')
                .update({ note: cleanNote })
                .eq('post_id', post.id)
                .eq('user_id', currentUserId);
            }

            // إشعار حقيقي لصاحب المنشور عند إعادة نشر منشور شخص آخر
            if (post.user_id !== currentUserId) {
              const notificationBase = {
                user_id: post.user_id,
                actor_id: currentUserId,
                type: 'repost',
                content: `${myName || 'مستخدم'} أعاد نشر منشورك`,
              };
              // أعمدة مرجع الكائن تختلف بين نسخ المخطط: نجرّب الأشكال المتاحة
              const attempts = [
                { ...notificationBase, reference_id: post.id, entity_id: post.id },
                { ...notificationBase, reference_id: post.id },
                { ...notificationBase, entity_id: post.id },
                notificationBase,
              ];
              for (const payload of attempts) {
                const { error } = await supabase.from('notifications').insert(payload);
                if (!error) break;
              }
            }
          } catch (error) {
            /* العمود أو الإشعار غير متاح بعد — لا يؤثر على إعادة النشر */
            console.warn('[share] تعذر تسجيل ملاحظة/إشعار إعادة النشر:', error);
          }
        }

        toast.success('تمت إعادة نشر المنشور');
        setNote('');
      } else {
        toast.success('تم إلغاء إعادة النشر');
      }
    } catch {
      /* الفشل عولج داخل دالة الإعادة الأصلية */
    } finally {
      setRepostBusy(false);
    }
  };

  const sheet = (
    <div
      className="fixed inset-0 z-[9999] flex items-end justify-center bg-black/70 backdrop-blur-sm"
      dir="rtl"
      role="presentation"
      onClick={close}
    >
      <section
        role="dialog"
        aria-modal="true"
        aria-label="مشاركة المنشور"
        onClick={event => event.stopPropagation()}
        className={`relative z-10 flex max-h-[86dvh] w-full max-w-lg flex-col overflow-hidden rounded-t-2xl border border-b-0 border-zinc-800 bg-zinc-950 text-white shadow-2xl transition-transform duration-200 ease-out ${
          shown ? 'translate-y-0' : 'translate-y-full'
        }`}
      >
        {/* مقبض السحب للأسفل */}
        <div
          className="flex shrink-0 cursor-grab justify-center pb-1 pt-2.5"
          onTouchStart={event => {
            touchStartY.current = event.touches[0].clientY;
          }}
          onTouchMove={event => {
            if (touchStartY.current !== null && event.touches[0].clientY - touchStartY.current > 60) {
              touchStartY.current = null;
              close();
            }
          }}
        >
          <div className="h-1 w-10 rounded-full bg-zinc-700" />
        </div>

        {/* الرأس: عنوان في المنتصف + بحث جانبي + إغلاق */}
        <div className="flex shrink-0 items-center justify-between px-4 pb-2">
          <button
            type="button"
            onClick={close}
            aria-label="إغلاق"
            className="rounded-full p-1.5 text-zinc-400 transition hover:bg-zinc-800 hover:text-white"
          >
            <X size={20} />
          </button>

          <h2 className="text-[15px] font-bold text-zinc-100">إرسال إلى</h2>

          <button
            type="button"
            onClick={() => setSearchOpen(open => !open)}
            aria-label="بحث"
            aria-pressed={searchOpen}
            className={`rounded-full p-1.5 transition hover:bg-zinc-800 ${
              searchOpen ? 'text-pink-400' : 'text-zinc-400 hover:text-white'
            }`}
          >
            <Search size={18} />
          </button>
        </div>

        {searchOpen && (
          <div className="shrink-0 px-4 pb-2">
            <div className="flex items-center gap-2 rounded-full border border-zinc-700/70 bg-zinc-900 px-3 py-2">
              <Search size={15} className="text-zinc-500" />
              <input
                autoFocus
                value={term}
                onChange={event => setTerm(event.target.value)}
                placeholder="ابحث بالاسم أو اسم المستخدم..."
                className="flex-1 bg-transparent text-sm text-zinc-100 outline-none placeholder-zinc-500"
              />
              {term && (
                <button
                  type="button"
                  onClick={() => setTerm('')}
                  aria-label="مسح البحث"
                  className="text-zinc-500 transition hover:text-white"
                >
                  <X size={14} />
                </button>
              )}
            </div>
          </div>
        )}

        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
          {/* الصف الأول: الأصدقاء والمتابَعون */}
          <div className="px-4 pt-1">
            <div className="flex items-center justify-between">
              <span className="text-[11px] font-bold text-zinc-400">الأصدقاء والمتابَعون</span>
              {selected.size > 0 && (
                <span className="text-[11px] font-bold text-pink-400">تم اختيار {selected.size}</span>
              )}
            </div>

            <div className="no-scrollbar mt-2 flex gap-3 overflow-x-auto pb-2">
              {loadingUsers ? (
                [0, 1, 2, 3, 4, 5].map(index => (
                  <div key={index} className="flex w-[62px] shrink-0 flex-col items-center gap-1">
                    <div className="h-14 w-14 animate-pulse rounded-full bg-zinc-800" />
                    <div className="h-2 w-12 rounded bg-zinc-800" />
                  </div>
                ))
              ) : users.length > 0 ? (
                users.map(user => (
                  <button
                    key={user.id}
                    type="button"
                    onClick={() => toggleSelect(user.id)}
                    aria-pressed={selected.has(user.id)}
                    className="flex w-[62px] shrink-0 flex-col items-center gap-1"
                  >
                    <span className="relative">
                      {user.avatar_url ? (
                        <img
                          src={user.avatar_url}
                          alt=""
                          className={`h-14 w-14 rounded-full object-cover transition ${
                            selected.has(user.id) ? 'ring-2 ring-pink-500' : 'ring-1 ring-zinc-700'
                          }`}
                        />
                      ) : (
                        <span
                          className={`flex h-14 w-14 items-center justify-center rounded-full bg-gradient-to-br from-pink-500 to-violet-600 text-sm font-bold text-white ${
                            selected.has(user.id) ? 'ring-2 ring-pink-500' : 'ring-1 ring-zinc-700'
                          }`}
                        >
                          {displayName(user).charAt(0)}
                        </span>
                      )}
                      {selected.has(user.id) && (
                        <span className="absolute -bottom-0.5 -left-0.5 flex h-[18px] w-[18px] items-center justify-center rounded-full bg-pink-600 text-white ring-2 ring-zinc-950">
                          <Check size={10} />
                        </span>
                      )}
                    </span>
                    <span className="w-full truncate text-center text-[10px] leading-4 text-zinc-300">
                      {displayName(user)}
                    </span>
                  </button>
                ))
              ) : (
                <p className="py-4 text-[11px] text-zinc-500">
                  {term.trim()
                    ? 'لا توجد نتائج مطابقة بين أصدقائك'
                    : 'لا يوجد أصدقاء أو متابَعون بعد — تابع أشخاصاً ليظهروا هنا'}
                </p>
              )}
            </div>
          </div>

          {/* الصف الثاني: المشاركة عبر */}
          <div className="px-4 pt-2">
            <span className="text-[11px] font-bold text-zinc-400">مشاركة عبر</span>

            <div className="no-scrollbar mt-2 flex gap-2.5 overflow-x-auto pb-3">
              <ShareAction
                icon={<Repeat2 size={18} />}
                label={reposted ? 'إلغاء الإعادة' : 'إعادة النشر'}
                tone={reposted ? 'emerald' : 'default'}
                busy={repostBusy}
                onClick={() => void handleRepost()}
              />
              <ShareAction
                icon={<MessageCircle size={18} />}
                label="واتساب"
                onClick={() =>
                  openExternal(`https://wa.me/?text=${encodeURIComponent(`${shareText} ${shareUrl}`)}`)
                }
              />
              <ShareAction
                icon={<Instagram size={18} />}
                label="إنستغرام"
                onClick={() => void shareToInstagram()}
              />
              <ShareAction icon={<Link2 size={18} />} label="نسخ الرابط" onClick={() => void copyLink()} />
              <ShareAction
                icon={<Ghost size={18} />}
                label="سناب شات"
                onClick={() => openExternal(`https://www.snapchat.com/scan?attachmentUrl=${encodedUrl}`)}
              />
              <ShareAction
                icon={<Send size={18} />}
                label="تيليجرام"
                onClick={() => openExternal(`https://t.me/share/url?url=${encodedUrl}&text=${encodedText}`)}
              />
              <ShareAction
                icon={<MessageSquare size={18} />}
                label="رسالة نصية"
                onClick={() => openExternal(`sms:?&body=${encodedText}%20${encodedUrl}`)}
              />
              <ShareAction
                icon={<Mail size={18} />}
                label="بريد"
                onClick={() =>
                  openExternal(
                    `mailto:?subject=${encodeURIComponent('منشور على آني')}&body=${encodedText}%20${encodedUrl}`,
                  )
                }
              />
              <ShareAction icon={<Share2 size={18} />} label="المزيد" onClick={() => void nativeShare()} />
            </div>
          </div>
        </div>

        {/* شريط الإرسال السفلي */}
        <div
          className="shrink-0 border-t border-zinc-800/80 bg-zinc-950 px-3 py-2.5"
          style={{ paddingBottom: 'max(0.625rem, env(safe-area-inset-bottom))' }}
        >
          <div className="flex items-center gap-2">
            <input
              value={note}
              onChange={event => setNote(event.target.value.slice(0, 300))}
              placeholder="أضف رسالة (اختياري)"
              className="min-w-0 flex-1 rounded-full border border-zinc-800 bg-zinc-900 px-3.5 py-2.5 text-xs text-zinc-100 outline-none placeholder-zinc-500 focus:border-pink-500/60"
            />
            {selected.size > 0 ? (
              <button
                type="button"
                onClick={() => void sendToSelected()}
                disabled={sending}
                className="flex shrink-0 items-center gap-1.5 rounded-full bg-pink-600 px-5 py-2.5 text-xs font-bold text-white transition hover:bg-pink-500 disabled:opacity-50"
              >
                {sending ? <Loader2 size={14} className="animate-spin" /> : <Send size={14} className="rotate-180" />}
                إرسال ({selected.size})
              </button>
            ) : (
              <span className="shrink-0 px-2 text-[10px] text-zinc-500">اختر شخصاً</span>
            )}
          </div>
        </div>
      </section>
    </div>
  );

  if (typeof document === 'undefined') return sheet;

  return createPortal(sheet, document.body);
};

const ShareAction: React.FC<{
  icon: React.ReactNode;
  label: string;
  onClick: () => void;
  tone?: 'default' | 'emerald';
  busy?: boolean;
}> = ({ icon, label, onClick, tone = 'default', busy = false }) => (
  <button
    type="button"
    onClick={onClick}
    disabled={busy}
    className="flex w-[62px] shrink-0 flex-col items-center gap-1.5 disabled:opacity-60"
  >
    <span
      className={`flex h-11 w-11 items-center justify-center rounded-full border border-zinc-800 bg-zinc-900 transition active:scale-95 ${
        tone === 'emerald' ? 'text-emerald-400' : 'text-zinc-200'
      }`}
    >
      {busy ? <Loader2 size={17} className="animate-spin" /> : icon}
    </span>
    <span className="w-full truncate text-center text-[10px] leading-4 text-zinc-400">{label}</span>
  </button>
);

export default ShareSheet;
