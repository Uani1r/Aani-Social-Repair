import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { toast } from 'sonner';

import { supabase, supabaseConfigured } from '../../lib/supabase';
import { displayName } from '../../lib/types';
import { postShareText, postShareUrl, recordShares } from '../../lib/interactions';
import ShareComposerFooter from './ShareComposerFooter';
import ShareMethodActions from './ShareMethodActions';
import ShareRecipientList from './ShareRecipientList';
import ShareSheetHeader from './ShareSheetHeader';
import type { ShareSheetProps } from './types';
import { useShareRecipients } from './useShareRecipients';

/**
 * الدفعات الجارية على مستوى الوحدة (لا المكوّن): تبقى فعّالة حتى لو أُغلقت
 * النافذة وأُزيل المكوّن، فلا يتكرر إرسال نفس المنشور لنفس المستلمين عند
 * إعادة الفتح أو النقر المزدوج.
 */
const inFlightSends = new Set<string>();

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

  // ملاحظة: لا يضبط هذا المكوّن document.body.style.overflow إطلاقاً.
  // القفل المركزي (useModalBodyScrollLock في App) يكتشف role="dialog" ويقفل/يفكّ
  // التمرير بعدّاد مشترك، فتعديل المكوّن للخاصية نفسها كان يترك body مقفلاً
  // بعد الإغلاق على iOS Safari (سباق قفلين على القيمة السابقة).

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
      .select('full_name, display_name, username')
      .eq('id', currentUserId)
      .maybeSingle()
      .then(({ data }) => {
        if (data) setMyName(displayName(data));
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

  // إرسال خلفي حقيقي: تُغلق النافذة فوراً عند قبول الأمر، ويستمر الإرسال
  // بالبيانات الملتقطة قبل الإغلاق (بلا أي اعتماد على state المكوّن بعد إزالته).
  const sendToSelected = () => {
    if (sendingRef.current || selected.size === 0) return;

    if (!supabaseConfigured) {
      toast.error('تعذر الإرسال: لا يوجد اتصال بقاعدة البيانات');
      return;
    }

    const recipients = Array.from(selected);
    const sendKey = `${post.id}:${currentUserId}:${[...recipients].sort().join(',')}`;
    if (inFlightSends.has(sendKey)) return;
    inFlightSends.add(sendKey);

    // نسخة ثابتة قبل إغلاق النافذة
    const targetPost = post;
    const senderId = currentUserId;
    const notifySent = onSent;
    const cleanNote = note.trim().slice(0, 500);
    const content = `[post:${post.id}]${cleanNote ? ` ${cleanNote}` : ''}`;

    sendingRef.current = true;
    setSending(true);
    setSelected(new Set());
    setNote('');

    // الإغلاق فوري — لا setTimeout مرتبط بالشبكة ولا انتظار لأي طلب
    close();

    void (async () => {
      try {
        const results = await Promise.all(
          recipients.map(async recipientId => {
            const payload = {
              sender_id: senderId,
              recipient_id: recipientId,
              content,
              post_id: targetPost.id,
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
        const failed = recipients.length - ok;

        if (ok === 0) {
          toast.error('تعذر إرسال المنشور. تحقق من الاتصال وحاول مجدداً.');
          return;
        }

        toast.success(
          failed === 0
            ? (ok === 1 ? 'تم إرسال المنشور' : `تم إرسال المنشور إلى ${ok} أشخاص`)
            : `تم إرسال المنشور إلى ${ok} من ${recipients.length}، وتعذر إرسال ${failed}`,
        );

        // العداد يُسجَّل بعدد الرسائل الناجحة فقط. recordShares يعيد boolean
        // (ولا يرمي) ويعرض رسالة الخطأ بنفسه — فلا نُحوّل الإرسال الناجح إلى
        // فشل وهمي، ولا نكتفي بتحذير Console عند فشل حقيقي.
        let counterSaved = false;
        try {
          counterSaved = await recordShares(targetPost, senderId, ok);
        } catch (counterError) {
          console.error('[share] استثناء غير متوقع أثناء تسجيل عداد المشاركة:', counterError);
        }
        if (!counterSaved) {
          console.error('[share] لم يُسجَّل عدّاد المشاركة في قاعدة البيانات (الرسائل أُرسلت بنجاح).');
        }

        notifySent?.(ok);
      } catch (error) {
        console.error('[share] خطأ أثناء الإرسال:', error);
        toast.error('تعذر إرسال المنشور. حاول مرة أخرى.');
      } finally {
        inFlightSends.delete(sendKey);
        sendingRef.current = false;
      }
    })();
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
      // النتيجة صريحة: true فقط بعد تأكيد الحفظ في قاعدة البيانات.
      // عند الفشل يبقى toggleRepost مسؤولاً عن حالة UI ورسالة الخطأ.
      const confirmed = await onToggleRepost();
      if (!confirmed) return;

      if (!reposted) {
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
                content: `${myName || ''} أعاد نشر منشورك`,
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

        setNote('');
      }
      // رسالة نجاح واحدة فقط — يعرضها toggleRepost بعد تأكيد قاعدة البيانات.
    } catch {
      /* معالج إعادة النشر الأصلي يعرض رسالة الفشل. */
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
