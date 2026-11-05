import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { toast } from 'sonner';

import { supabase, supabaseConfigured } from '../../lib/supabase';
import { postShareText, postShareUrl, recordShares } from '../../lib/interactions';
import ShareComposerFooter from './ShareComposerFooter';
import ShareMethodActions from './ShareMethodActions';
import ShareRecipientList from './ShareRecipientList';
import ShareSheetHeader from './ShareSheetHeader';
import type { ShareSheetProps } from './types';
import { useShareRecipients } from './useShareRecipients';

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
  const [term, setTerm] = useState('');
  const [searchOpen, setSearchOpen] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [sending, setSending] = useState(false);
  const [note, setNote] = useState('');
  const [repostBusy, setRepostBusy] = useState(false);
  const [myName, setMyName] = useState('');
  const touchStartY = useRef<number | null>(null);
  const sendingRef = useRef(false);
  const { users, loadingUsers } = useShareRecipients(currentUserId, term);

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

      // يسجل نجاح الإرسال لكل مستلم ويحدّث العداد فوراً في الواجهة وقاعدة البيانات
      await recordShares(post, currentUserId, ok);

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
        /* The user cancelled sharing. */
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
            console.warn('[share] تعذر تسجيل ملاحظة/إشعار إعادة النشر:', error);
          }
        }

        toast.success('تمت إعادة نشر المنشور');
        setNote('');
      } else {
        toast.success('تم إلغاء إعادة النشر');
      }
    } catch {
      /* The original repost handler reports errors. */
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
        <div
          className="flex shrink-0 cursor-grab justify-center pb-1 pt-2.5"
          onTouchStart={event => {
            touchStartY.current = event.touches[0].clientY;
          }}
          onTouchMove={event => {
            if (
              touchStartY.current !== null &&
              event.touches[0].clientY - touchStartY.current > 60
            ) {
              touchStartY.current = null;
              close();
            }
          }}
        >
          <div className="h-1 w-10 rounded-full bg-zinc-700" />
        </div>

        <ShareSheetHeader
          onClose={close}
          searchOpen={searchOpen}
          onToggleSearch={() => setSearchOpen(open => !open)}
          term={term}
          onTermChange={setTerm}
        />

        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
          <ShareRecipientList
            users={users}
            loadingUsers={loadingUsers}
            term={term}
            selected={selected}
            onToggleSelect={toggleSelect}
          />

          <ShareMethodActions
            reposted={reposted}
            repostBusy={repostBusy}
            onRepost={() => void handleRepost()}
            onWhatsApp={() =>
              openExternal(`https://wa.me/?text=${encodeURIComponent(`${shareText} ${shareUrl}`)}`)
            }
            onInstagram={() => void shareToInstagram()}
            onCopyLink={() => void copyLink()}
            onSnapchat={() =>
              openExternal(`https://www.snapchat.com/scan?attachmentUrl=${encodedUrl}`)
            }
            onTelegram={() =>
              openExternal(`https://t.me/share/url?url=${encodedUrl}&text=${encodedText}`)
            }
            onSms={() => openExternal(`sms:?&body=${encodedText}%20${encodedUrl}`)}
            onEmail={() =>
              openExternal(
                `mailto:?subject=${encodeURIComponent('منشور على آني')}&body=${encodedText}%20${encodedUrl}`,
              )
            }
            onNativeShare={() => void nativeShare()}
          />
        </div>

        <ShareComposerFooter
          note={note}
          selectedCount={selected.size}
          sending={sending}
          onNoteChange={setNote}
          onSend={() => void sendToSelected()}
        />
      </section>
    </div>
  );

  if (typeof document === 'undefined') return sheet;

  return createPortal(sheet, document.body);
};

export default ShareSheet;
