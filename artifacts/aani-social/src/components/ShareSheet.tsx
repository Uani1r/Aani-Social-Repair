import React, { useEffect, useRef, useState } from 'react';
import {
  Check,
  Copy,
  Loader2,
  Repeat2,
  Search,
  Send,
  X,
} from 'lucide-react';
import { toast } from 'sonner';

import { supabase, supabaseConfigured } from '../lib/supabase';
import { postShareText, postShareUrl } from '../lib/interactions';
import type { Post, Profile } from '../lib/types';

interface ShareSheetProps {
  post: Post;
  currentUserId: string;
  reposted?: boolean;
  onToggleRepost?: () => void | Promise<void>;
  onRecordExternalShare?: () => void;
  onClose: () => void;
}

/**
 * نافذة المشاركة السفلية: إرسال خاص للأصدقاء (قاعدة بيانات حقيقية)،
 * إعادة نشر مع ملاحظة، ومشاركة خارجية عبر روابط النظام.
 */
const ShareSheet: React.FC<ShareSheetProps> = ({
  post,
  currentUserId,
  reposted = false,
  onToggleRepost,
  onRecordExternalShare,
  onClose,
}) => {
  const [shown, setShown] = useState(false);
  const [users, setUsers] = useState<Profile[]>([]);
  const [loadingUsers, setLoadingUsers] = useState(true);
  const [term, setTerm] = useState('');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [sending, setSending] = useState(false);
  const [repostNote, setRepostNote] = useState('');
  const [repostBusy, setRepostBusy] = useState(false);
  const [myName, setMyName] = useState('');
  const touchStartY = useRef<number | null>(null);

  const close = () => {
    setShown(false);
    window.setTimeout(onClose, 200);
  };

  useEffect(() => {
    const raf = requestAnimationFrame(() => setShown(true));
    return () => cancelAnimationFrame(raf);
  }, []);

  // قائمة المستخدمين الحقيقيين من قاعدة البيانات (بدون بيانات وهمية)
  useEffect(() => {
    if (!supabaseConfigured) {
      setLoadingUsers(false);
      return;
    }

    let active = true;
    const t = term.trim();
    const timer = window.setTimeout(async () => {
      try {
        let query = supabase
          .from('profiles')
          .select('id, username, full_name, avatar_url')
          .neq('id', currentUserId)
          .order('full_name')
          .limit(30);

        if (t) {
          query = query.or(`full_name.ilike.%${t}%,username.ilike.%${t}%`);
        }

        const { data } = await query;

        if (active) {
          setUsers((data || []) as Profile[]);
          setLoadingUsers(false);
        }
      } catch (error) {
        console.error('Error loading share users:', error);
        if (active) {
          setUsers([]);
          setLoadingUsers(false);
        }
      }
    }, 250);

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

  const shareUrl = postShareUrl(post.id);
  const shareText = postShareText(post);
  const encodedUrl = encodeURIComponent(shareUrl);
  const encodedText = encodeURIComponent(shareText);

  const sendToSelected = async () => {
    if (sending || selected.size === 0 || !supabaseConfigured) return;

    setSending(true);
    try {
      const caption = repostNote.trim();
      const messageContent = `${caption ? `${caption}\n\n` : ''}${postShareText(post)}\n${postShareUrl(post.id)}`;

      const results = await Promise.allSettled(
        Array.from(selected).map(recipientId =>
          supabase.from('messages').insert({
            sender_id: currentUserId,
            recipient_id: recipientId,
            content: messageContent,
          }),
        ),
      );

      const ok = results.filter(
        r => r.status === 'fulfilled' && !r.value.error,
      ).length;

      if (ok === 0) {
        toast.error('تعذر إرسال المنشور. تحقق من الاتصال وحاول مجدداً.');
        return;
      }

      toast.success(`تم إرسال المنشور إلى ${ok} ${ok === 1 ? 'شخص' : 'أشخاص'}`);
      setSelected(new Set());
      setRepostNote('');
      close();
    } finally {
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

  const handleRepost = async () => {
    if (repostBusy) return;

    setRepostBusy(true);
    try {
      await onToggleRepost?.();

      // تسجيل الملاحظة على صف إعادة النشر بعد إتمام الإعادة (تمامًا عند النجاح فقط)
      const wasReposting = !reposted;
      if (wasReposting && supabaseConfigured) {
        try {
          const note = repostNote.trim();
          if (note) {
            await supabase
              .from('reposts')
              .update({ note })
              .eq('post_id', post.id)
              .eq('user_id', currentUserId);
          }

          // إشعار حقيقي لصاحب المنشور عند إعادة نشر منشور شخص آخر
          if (post.user_id !== currentUserId) {
            await supabase.from('notifications').insert({
              user_id: post.user_id,
              actor_id: currentUserId,
              type: 'repost',
              content: `${myName || 'مستخدم'} أعاد نشر منشورك`,
              entity_id: post.id,
            });
          }
        } catch {
          /* العمود غير موجود بعد أو فشل الإشعار — لا يؤثر على الإعادة */
        }

        toast.success('تمت إعادة نشر المنشور');
        setRepostNote('');
      } else if (reposted) {
        toast.success('تم إلغاء إعادة النشر');
      }
    } catch {
      /* الفشل عولج داخل دالة الإعادة الأصلية */
    } finally {
      setRepostBusy(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-[110] flex items-end justify-center bg-black/70 backdrop-blur-sm"
      dir="rtl"
      onClick={close}
    >
      <section
        onClick={e => e.stopPropagation()}
        className={`relative z-10 flex max-h-[82dvh] w-full max-w-lg flex-col rounded-t-3xl border border-b-0 border-zinc-800 bg-zinc-950 text-white shadow-2xl transition-transform duration-200 ease-out ${
          shown ? 'translate-y-0' : 'translate-y-full'
        }`}
      >
        {/* مقبض السحب للأسفل */}
        <div
          className="flex cursor-grab justify-center pb-1 pt-3"
          onTouchStart={e => {
            touchStartY.current = e.touches[0].clientY;
          }}
          onTouchMove={e => {
            if (touchStartY.current !== null && e.touches[0].clientY - touchStartY.current > 60) {
              touchStartY.current = null;
              close();
            }
          }}
        >
          <div className="h-1 w-10 rounded-full bg-zinc-700" />
        </div>

        <div className="flex items-center justify-between border-b border-zinc-800/60 px-4 pb-2">
          <button
            onClick={close}
            className="rounded-full p-1.5 text-zinc-400 transition hover:bg-zinc-800 hover:text-white"
            aria-label="إغلاق"
          >
            <X size={20} />
          </button>
          <h2 className="text-base font-bold text-zinc-100">مشاركة</h2>
          <div className="w-8" />
        </div>

        {/* إعادة النشر مع ملاحظة */}
        <div className="mx-4 mt-3 rounded-2xl border border-zinc-800 bg-zinc-900/70 p-3">
          <div className="flex items-center justify-between gap-2">
            <span className="text-sm font-bold text-zinc-100">
              <Repeat2 size={16} className="me-1 inline text-emerald-400" />
              إعادة النشر
            </span>
            <button
              onClick={() => void handleRepost()}
              disabled={repostBusy}
              className={`rounded-full px-4 py-1.5 text-xs font-bold transition disabled:opacity-50 ${
                reposted
                  ? 'bg-zinc-800 text-zinc-300 hover:bg-zinc-700'
                  : 'bg-emerald-600 text-white hover:bg-emerald-500'
              }`}
            >
              {repostBusy ? 'جارٍ...' : reposted ? 'إلغاء إعادة النشر' : 'إعادة النشر'}
            </button>
          </div>
          {!reposted && (
            <textarea
              value={repostNote}
              onChange={e => setRepostNote(e.target.value.slice(0, 200))}
              rows={2}
              placeholder="ملاحظة قصيرة مع الإعادة (اختياري)"
              className="mt-2 w-full resize-none rounded-xl border border-zinc-800 bg-zinc-950 p-2 text-xs text-zinc-200 outline-none placeholder-zinc-500 focus:border-pink-500/50"
              dir="rtl"
            />
          )}
        </div>

        {/* الإرسال إلى الأصدقاء */}
        <div className="flex-1 overflow-y-auto px-4 py-3">
          <div className="flex items-center gap-2 rounded-full border border-zinc-700/70 bg-zinc-900 px-3 py-2">
            <Search size={16} className="text-zinc-400" />
            <input
              value={term}
              onChange={e => setTerm(e.target.value)}
              placeholder="ابحث عن أصدقائك للإرسال..."
              className="flex-1 bg-transparent text-sm text-zinc-100 outline-none placeholder-zinc-500"
            />
          </div>

          <div className="mt-3 flex gap-3 overflow-x-auto pb-2">
            {loadingUsers
              ? [0, 1, 2, 3, 4].map(i => (
                  <div key={i} className="flex w-16 shrink-0 flex-col items-center gap-1">
                    <div className="h-14 w-14 animate-pulse rounded-full bg-zinc-800" />
                    <div className="h-2 w-12 rounded bg-zinc-800" />
                  </div>
                ))
              : users.map(u => (
                  <button
                    key={u.id}
                    onClick={() => toggleSelect(u.id)}
                    className="flex w-16 shrink-0 flex-col items-center gap-1"
                  >
                    <span className="relative">
                      {u.avatar_url ? (
                        <img
                          src={u.avatar_url}
                          alt={u.full_name}
                          className={`h-14 w-14 rounded-full object-cover ring-2 ${
                            selected.has(u.id) ? 'ring-pink-500' : 'ring-zinc-700'
                          }`}
                        />
                      ) : (
                        <span
                          className={`flex h-14 w-14 items-center justify-center rounded-full bg-gradient-to-br from-pink-500 to-violet-600 text-sm font-bold text-white ring-2 ${
                            selected.has(u.id) ? 'ring-pink-500' : 'ring-zinc-700'
                          }`}
                        >
                          {u.full_name?.charAt(0) || 'آ'}
                        </span>
                      )}
                      {selected.has(u.id) && (
                        <span className="absolute bottom-0 left-0 flex h-4 w-4 items-center justify-center rounded-full bg-pink-600 text-white">
                          <Check size={10} />
                        </span>
                      )}
                    </span>
                    <span className="w-full truncate text-center text-[10px] text-zinc-300">
                      {u.full_name || 'مستخدم آني'}
                    </span>
                  </button>
                ))}
          </div>

          {!loadingUsers && users.length === 0 && (
            <p className="py-4 text-center text-xs text-zinc-500">
              {term.trim() ? 'لا توجد نتائج مطابقة' : 'لا يوجد مستخدمون بعد'}
            </p>
          )}
        </div>

        {/* المشاركة الخارجية + زر الإرسال */}
        <div
          className="shrink-0 border-t border-zinc-800/80 bg-zinc-900/60 px-4 py-3"
          style={{ paddingBottom: 'max(0.75rem, env(safe-area-inset-bottom))' }}
        >
          <div className="mb-3 grid grid-cols-5 gap-2">
            <ExternalOption icon="📋" label="نسخ الرابط" onClick={() => void copyLink()} />
            <ExternalOption
              icon="💬"
              label="واتساب"
              onClick={() =>
                openExternal(`https://wa.me/?text=${encodeURIComponent(`${shareText} ${shareUrl}`)}`)
              }
            />
            <ExternalOption
              icon="✈️"
              label="تيليجرام"
              onClick={() => openExternal(`https://t.me/share/url?url=${encodedUrl}&text=${encodedText}`)}
            />
            <ExternalOption
              icon="✉️"
              label="رسالة نصية"
              onClick={() => openExternal(`sms:?&body=${encodedText}%20${encodedUrl}`)}
            />
            <ExternalOption
              icon="📧"
              label="بريد إلكتروني"
              onClick={() =>
                openExternal(`mailto:?subject=${encodeURIComponent('منشور على آني')}&body=${encodedText}%20${encodedUrl}`)
              }
            />
          </div>

          <div className="flex items-center gap-2">
            <button
              onClick={() => void nativeShare()}
              className="flex-1 rounded-full border border-zinc-700 py-2.5 text-center text-xs font-bold text-zinc-200 transition hover:bg-zinc-800"
            >
              المزيد (مشاركة النظام)
            </button>
            <button
              onClick={() => void sendToSelected()}
              disabled={selected.size === 0 || sending}
              className="flex shrink-0 items-center gap-1.5 rounded-full bg-pink-600 px-6 py-2.5 text-xs font-bold text-white transition hover:bg-pink-500 disabled:cursor-not-allowed disabled:opacity-40"
            >
              {sending ? <Loader2 size={14} className="animate-spin" /> : <Send size={14} className="rotate-180" />}
              إرسال{selected.size > 0 ? ` (${selected.size})` : ''}
            </button>
          </div>
        </div>
      </section>
    </div>
  );
};

const ExternalOption: React.FC<{ icon: string; label: string; onClick: () => void }> = ({
  icon,
  label,
  onClick,
}) => (
  <button
    onClick={onClick}
    className="flex flex-col items-center gap-1 rounded-xl border border-zinc-800 bg-zinc-900/60 py-2 text-[10px] text-zinc-300 transition hover:bg-zinc-800"
  >
    <span className="text-lg">{icon}</span>
    {label}
  </button>
);

export default ShareSheet;