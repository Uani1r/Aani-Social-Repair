import { useEffect, useState } from 'react';
import * as DialogPrimitive from '@radix-ui/react-dialog';
import { EyeOff, Heart, LockKeyhole, MessageCircle, Users, X } from 'lucide-react';
import { toast } from 'sonner';

import CustomAllowedCommentersModal from '@/components/CustomAllowedCommentersModal';
import { useBottomSheetDismiss } from '@/hooks/useBottomSheetDismiss';
import { supabase, supabaseConfigured } from '@/lib/supabase';
import type { CommentPrivacy, Post } from '@/lib/types';

type PostPrivacySheetProps = {
  open: boolean;
  post: Post;
  currentUserId: string;
  onClose: () => void;
  onSaved: () => void;
};

type PrivacySwitchProps = {
  checked: boolean;
  disabled?: boolean;
  onChange: (checked: boolean) => void;
  icon: typeof Heart;
  title: string;
  description: string;
};

function PrivacySwitch({ checked, disabled, onChange, icon: Icon, title, description }: PrivacySwitchProps) {
  return (
    <div className="flex items-center gap-3 rounded-2xl border border-white/[0.07] bg-white/[0.035] px-4 py-3.5">
      <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-white/[0.07] text-white/75">
        <Icon size={18} />
      </span>
      <div className="min-w-0 flex-1">
        <span className="block text-[13px] font-semibold text-white">{title}</span>
        <span className="mt-1 block text-[10px] leading-4 text-white/45">{description}</span>
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        aria-label={title}
        disabled={disabled}
        onClick={() => onChange(!checked)}
        className={`relative h-6 w-11 shrink-0 rounded-full transition disabled:opacity-50 ${checked ? 'bg-violet-500' : 'bg-white/20'}`}
      >
        <span className={`absolute top-1 h-4 w-4 rounded-full bg-white transition-all ${checked ? 'right-1' : 'right-6'}`} />
      </button>
    </div>
  );
}

export default function PostPrivacySheet({ open, post, currentUserId, onClose, onSaved }: PostPrivacySheetProps) {
  const [hideLikes, setHideLikes] = useState(Boolean(post.hide_likes));
  const [hideComments, setHideComments] = useState(Boolean(post.hide_comments));
  const [commentPrivacy, setCommentPrivacy] = useState<CommentPrivacy>(post.comment_privacy || 'public');
  const [allowedCommenters, setAllowedCommenters] = useState<string[]>([]);
  const [allowedCommentersLoaded, setAllowedCommentersLoaded] = useState(false);
  const [allowedCommentersLoading, setAllowedCommentersLoading] = useState(false);
  const [allowedCommentersError, setAllowedCommentersError] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const { dragOffset, dragging, ...dismissHandlers } = useBottomSheetDismiss(open, onClose);

  useEffect(() => {
    if (!open) return;
    let active = true;
    setHideLikes(Boolean(post.hide_likes));
    setHideComments(Boolean(post.hide_comments));
    setCommentPrivacy(post.comment_privacy || 'public');
    setAllowedCommenters([]);
    setAllowedCommentersLoaded(false);
    setAllowedCommentersLoading(true);
    setAllowedCommentersError(false);
    setPickerOpen(false);

    void (async () => {
      const { data, error } = await supabase.rpc('aani_get_allowed_commenters', { p_post_id: post.id });
      if (!active) return;
      if (error || !Array.isArray(data)) {
        setAllowedCommentersLoading(false);
        setAllowedCommentersError(true);
        return;
      }
      setAllowedCommenters(data.filter((id: unknown): id is string => typeof id === 'string'));
      setAllowedCommentersLoaded(true);
      setAllowedCommentersLoading(false);
    })().catch(() => {
      if (!active) return;
      setAllowedCommentersLoading(false);
      setAllowedCommentersError(true);
    });

    return () => {
      active = false;
    };
  }, [open, post.id, post.hide_likes, post.hide_comments, post.comment_privacy]);

  const save = async () => {
    if (saving) return;
    if (!allowedCommentersLoaded || allowedCommentersError) {
      toast.error('تعذر تحميل إعدادات التعليقات. أغلق النافذة وأعد فتحها ثم حاول مجددًا.');
      return;
    }
    if (!supabaseConfigured) {
      toast.error('قاعدة البيانات غير مهيأة.');
      return;
    }

    setSaving(true);
    const { error } = await supabase
      .from('posts')
      .update({
        hide_likes: hideLikes,
        hide_comments: hideComments,
        comment_privacy: commentPrivacy,
        allowed_commenters: [...new Set(allowedCommenters.filter(id => id !== post.user_id))],
      })
      .eq('id', post.id)
      .eq('user_id', currentUserId);

    if (error) {
      toast.error('تعذر حفظ الخصوصية. تأكد من تطبيق ترحيل خصوصية المنشورات في Supabase.');
      setSaving(false);
      return;
    }

    toast.success('تم حفظ إعدادات الخصوصية');
    setSaving(false);
    onSaved();
    onClose();
  };

  const selectCommentPrivacy = (value: CommentPrivacy) => {
    setCommentPrivacy(value);
    if (value === 'custom') setPickerOpen(true);
  };

  return (
    <>
      <DialogPrimitive.Root open={open} onOpenChange={nextOpen => { if (!nextOpen) onClose(); }}>
        <DialogPrimitive.Portal>
          <DialogPrimitive.Overlay className="fixed inset-0 z-[110] bg-black/70 backdrop-blur-[5px]" />
          <DialogPrimitive.Content
            dir="rtl"
            className="fixed inset-x-0 bottom-0 z-[111] mx-auto max-h-[90dvh] w-full max-w-[500px] overflow-y-auto rounded-t-[28px] border border-white/10 bg-[#19191d]/[0.98] px-5 pt-3 text-white shadow-[0_-12px_50px_rgba(0,0,0,0.55)] focus:outline-none"
            style={{
              transform: dragOffset > 0 ? `translate3d(0, ${dragOffset}px, 0)` : undefined,
              transition: dragging ? 'none' : 'transform 220ms ease-out',
              paddingBottom: 'max(24px, env(safe-area-inset-bottom))',
            }}
            aria-describedby={undefined}
            {...dismissHandlers}
          >
            <div className="mx-auto mb-3 h-1 w-10 rounded-full bg-white/25" aria-hidden="true" />
            <header className="flex items-center justify-between border-b border-white/10 pb-4">
              <div>
                <DialogPrimitive.Title className="text-base font-bold">خصوصية المنشور</DialogPrimitive.Title>
                <p className="mt-1 text-[10px] text-white/45">تحكم في التفاعلات والتعليقات على هذا المنشور</p>
              </div>
              <button type="button" onClick={onClose} aria-label="إغلاق إعدادات الخصوصية" className="rounded-full bg-white/[0.07] p-2 text-white/65 transition hover:bg-white/10 hover:text-white">
                <X size={18} />
              </button>
            </header>

            <div className="space-y-3 py-4">
              <PrivacySwitch
                checked={hideLikes}
                disabled={saving}
                onChange={setHideLikes}
                icon={Heart}
                title="إخفاء عدد الإعجابات"
                description="لن يظهر عدد الإعجابات للآخرين، وستظل قادراً على الإعجاب بالمنشور."
              />
              <PrivacySwitch
                checked={hideComments}
                disabled={saving}
                onChange={setHideComments}
                icon={EyeOff}
                title="إخفاء التعليقات"
                description="لن يرى الآخرون التعليقات أو يضيفوا تعليقات جديدة على هذا المنشور."
              />

              <section className="rounded-2xl border border-white/[0.07] bg-white/[0.035] p-4">
                <div className="mb-3 flex items-start gap-3">
                  <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-white/[0.07] text-white/75">
                    <MessageCircle size={18} />
                  </span>
                  <div>
                    <h3 className="text-[13px] font-semibold">من يستطيع التعليق؟</h3>
                    <p className="mt-1 text-[10px] leading-4 text-white/45">اختر من يُسمح له بإضافة تعليق. إخفاء التعليقات يتحكم في عرضها للآخرين.</p>
                  </div>
                </div>

                <div role="radiogroup" aria-label="من يستطيع التعليق؟" className="space-y-2">
                  {([
                    { value: 'public', title: 'الجميع', description: 'كل مستخدمي آني', icon: Users },
                    { value: 'followers', title: 'المتابعون', description: 'الأشخاص الذين يتابعونك', icon: Users },
                    { value: 'custom', title: 'أشخاص محددون', description: 'اختر من الأصدقاء ذوي المتابعة المتبادلة', icon: LockKeyhole },
                  ] as const).map(option => {
                    const selected = commentPrivacy === option.value;
                    const Icon = option.icon;
                    return (
                      <button
                        key={option.value}
                        type="button"
                        role="radio"
                        aria-checked={selected}
                        disabled={saving || allowedCommentersLoading || allowedCommentersError}
                        onClick={() => selectCommentPrivacy(option.value)}
                        className={`flex w-full items-center gap-3 rounded-xl border px-3 py-2.5 text-right transition disabled:opacity-50 ${selected ? 'border-violet-400/50 bg-violet-500/[0.12]' : 'border-white/[0.06] bg-black/10 hover:bg-white/[0.05]'}`}
                      >
                        <Icon size={16} className={selected ? 'text-violet-300' : 'text-white/45'} />
                        <span className="min-w-0 flex-1">
                          <span className="block text-[11px] font-semibold text-white">{option.title}</span>
                          <span className="mt-0.5 block text-[9px] text-white/40">{option.description}</span>
                        </span>
                        <span className={`grid h-4 w-4 place-items-center rounded-full border ${selected ? 'border-violet-300' : 'border-white/30'}`}>
                          {selected && <span className="h-2 w-2 rounded-full bg-violet-300" />}
                        </span>
                      </button>
                    );
                  })}
                </div>

                {commentPrivacy === 'custom' && (
                  <button
                    type="button"
                    disabled={saving || allowedCommentersLoading || allowedCommentersError}
                    onClick={() => setPickerOpen(true)}
                    className="mt-3 flex w-full items-center justify-between rounded-xl border border-violet-400/25 bg-violet-500/[0.08] px-3 py-3 text-right transition hover:bg-violet-500/[0.14] disabled:opacity-50"
                  >
                    <span>
                      <span className="block text-[11px] font-semibold text-violet-100">تحديد الأشخاص</span>
                      <span className="mt-1 block text-[9px] text-violet-100/55">{allowedCommentersLoading ? 'جارٍ تحميل القائمة…' : `${allowedCommenters.length} حسابات محددة`}</span>
                    </span>
                    <span className="text-xs font-bold text-violet-200">اختيار</span>
                  </button>
                )}
              </section>
            </div>

            <footer className="border-t border-white/10 pt-4">
              {allowedCommentersError && <p role="alert" className="mb-3 text-center text-[10px] text-rose-300">تعذر تحميل إعدادات الأشخاص المسموح لهم بالتعليق. أغلق النافذة وأعد فتحها للمحاولة مجددًا.</p>}
              <div className="flex gap-2">
                <button type="button" onClick={onClose} disabled={saving} className="flex-1 rounded-2xl border border-white/10 px-4 py-3 text-xs font-semibold text-white/70 transition hover:bg-white/[0.06] disabled:opacity-50">
                  إلغاء
                </button>
                <button type="button" onClick={() => void save()} disabled={saving || !allowedCommentersLoaded || allowedCommentersError} className="flex-1 rounded-2xl bg-gradient-to-r from-violet-500 to-fuchsia-500 px-4 py-3 text-xs font-bold text-white shadow-lg shadow-violet-950/30 transition hover:brightness-110 disabled:opacity-50">
                  {saving ? 'جارٍ الحفظ…' : allowedCommentersLoading ? 'جارٍ تحميل الإعدادات…' : 'حفظ الإعدادات'}
                </button>
              </div>
            </footer>

            <CustomAllowedCommentersModal
              open={pickerOpen}
              ownerId={post.user_id}
              selectedIds={allowedCommenters}
              onClose={() => setPickerOpen(false)}
              onSave={ids => {
                setAllowedCommenters(ids);
                setPickerOpen(false);
              }}
            />
          </DialogPrimitive.Content>
        </DialogPrimitive.Portal>
      </DialogPrimitive.Root>
    </>
  );
}
