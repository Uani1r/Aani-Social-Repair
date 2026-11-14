import type { Dispatch, FormEvent, MutableRefObject, SetStateAction } from 'react';
import { toast } from 'sonner';

import type {
  StoryViewerEntry,
} from '@/lib/appShared';
import { supabase, supabaseConfigured } from '@/lib/supabase';
import { pushGlobalError } from '@/lib/globalErrorStore';
import { displayName } from '@/lib/types';
import type { StoryRow } from './types';

type StoryReportCategory = 'spam' | 'harassment' | 'hate' | 'fake_account' | 'other';

type StoryDataLoader = (storyId: string, requestId: number) => Promise<StoryViewerEntry[] | null>;

interface UseStoryViewerActionsOptions {
  userId: string;
  currentStory: StoryRow | null;
  isStoryOwner: boolean;
  isPaused: boolean;
  storyViewsOpen: boolean;
  storyViewers: StoryViewerEntry[];
  viewerActionBusyId: string | null;
  viewerReportTarget: StoryViewerEntry | null;
  viewerReportCategory: StoryReportCategory;
  viewerReportDetails: string;
  viewerReportBusy: boolean;
  isLiked: boolean;
  isLikeSaving: boolean;
  isSendingReply: boolean;
  replyText: string;
  storyViewsWasPausedRef: MutableRefObject<boolean>;
  storyVideoRef: MutableRefObject<HTMLVideoElement | null>;
  storyVideoWasPlayingRef: MutableRefObject<boolean>;
  storyViewsRequestRef: MutableRefObject<number>;
  storyViewsChannelRef: MutableRefObject<ReturnType<typeof supabase.channel> | null>;
  loadStoryViewerEntries: StoryDataLoader;
  setStoryViewsOpen: Dispatch<SetStateAction<boolean>>;
  setStoryViewsLoading: Dispatch<SetStateAction<boolean>>;
  setStoryViewsError: Dispatch<SetStateAction<boolean>>;
  setStoryViewsCount: Dispatch<SetStateAction<number>>;
  setStoryViewers: Dispatch<SetStateAction<StoryViewerEntry[]>>;
  setViewerActionBusyId: Dispatch<SetStateAction<string | null>>;
  setViewerReportTarget: Dispatch<SetStateAction<StoryViewerEntry | null>>;
  setViewerReportCategory: Dispatch<SetStateAction<StoryReportCategory>>;
  setViewerReportDetails: Dispatch<SetStateAction<string>>;
  setViewerReportBusy: Dispatch<SetStateAction<boolean>>;
  setViewerRowMenuOpen: Dispatch<SetStateAction<boolean>>;
  setIsPaused: Dispatch<SetStateAction<boolean>>;
  setIsLiked: Dispatch<SetStateAction<boolean>>;
  setIsLikeSaving: Dispatch<SetStateAction<boolean>>;
  setIsSendingReply: Dispatch<SetStateAction<boolean>>;
  setReplyText: Dispatch<SetStateAction<string>>;
  setShowMenu: Dispatch<SetStateAction<boolean>>;
}

export function useStoryViewerActions({
  userId,
  currentStory,
  isStoryOwner,
  isPaused,
  storyViewsOpen,
  storyViewers,
  viewerActionBusyId,
  viewerReportTarget,
  viewerReportCategory,
  viewerReportDetails,
  viewerReportBusy,
  isLiked,
  isLikeSaving,
  isSendingReply,
  replyText,
  storyViewsWasPausedRef,
  storyVideoRef,
  storyVideoWasPlayingRef,
  storyViewsRequestRef,
  storyViewsChannelRef,
  loadStoryViewerEntries,
  setStoryViewsOpen,
  setStoryViewsLoading,
  setStoryViewsError,
  setStoryViewsCount,
  setStoryViewers,
  setViewerActionBusyId,
  setViewerReportTarget,
  setViewerReportCategory,
  setViewerReportDetails,
  setViewerReportBusy,
  setViewerRowMenuOpen,
  setIsPaused,
  setIsLiked,
  setIsLikeSaving,
  setIsSendingReply,
  setReplyText,
  setShowMenu,
}: UseStoryViewerActionsOptions) {
  const handleOpenStoryViews = async (wasPausedBeforeOpen = isPaused) => {
    if (!currentStory || !isStoryOwner || !supabaseConfigured || storyViewsOpen) return;

    const storyId = currentStory.id;
    const requestId = ++storyViewsRequestRef.current;
    storyViewsWasPausedRef.current = wasPausedBeforeOpen;
    storyVideoWasPlayingRef.current = Boolean(storyVideoRef.current && !storyVideoRef.current.paused);
    storyVideoRef.current?.pause();
    setIsPaused(true);
    setStoryViewsOpen(true);
    setStoryViewsLoading(true);
    setStoryViewsError(false);
    setStoryViewers([]);

    if (storyViewsChannelRef.current) {
      void supabase.removeChannel(storyViewsChannelRef.current);
      storyViewsChannelRef.current = null;
    }

    try {
      const rows = await loadStoryViewerEntries(storyId, requestId);
      if (!rows || requestId !== storyViewsRequestRef.current) return;

      const refreshStoryViewerEntries = () => {
        const refreshRequestId = ++storyViewsRequestRef.current;
        void loadStoryViewerEntries(storyId, refreshRequestId).catch(error => {
          if (refreshRequestId !== storyViewsRequestRef.current) return;
          console.error('[story views] تعذر تحديث قائمة المشاهدين:', error);
          setStoryViewsError(true);
        });
      };

      const channel = supabase
        .channel(`story-viewers:${storyId}:${requestId}`)
        .on('postgres_changes', {
          event: 'INSERT',
          schema: 'public',
          table: 'story_views',
          filter: `story_id=eq.${storyId}`,
        }, refreshStoryViewerEntries)
        .on('postgres_changes', {
          event: '*',
          schema: 'public',
          table: 'story_likes',
          filter: `story_id=eq.${storyId}`,
        }, refreshStoryViewerEntries)
        .subscribe();
      storyViewsChannelRef.current = channel;
    } catch (error) {
      if (requestId !== storyViewsRequestRef.current || currentStory?.id !== storyId) return;
      console.error('[story views] تعذر تحميل قائمة المشاهدين:', error);
      // نظام التشخيص الشامل: رمز الخطأ الحقيقي (PGRST*/42703/42501...) والرسالة
      // الكاملة مع details/hint — بدل إخفائه خلف رسالة عامة
      const errorInfo = error && typeof error === 'object'
        ? error as { message?: unknown; details?: unknown; hint?: unknown; code?: unknown }
        : null;
      const rawMessage = error instanceof Error
        ? error.message
        : typeof errorInfo?.message === 'string' ? errorInfo.message : '';
      pushGlobalError({
        screen: 'StoryViewersSheet (المشاهدات والإعجابات)',
        target: 'story_viewer_entries + story_likes (Supabase)',
        error,
        message: rawMessage || 'فشل تحميل قائمة المشاهدين',
        details: typeof errorInfo?.details === 'string' ? errorInfo.details : undefined,
        hint: typeof errorInfo?.hint === 'string' ? errorInfo.hint : undefined,
      });
      setStoryViewsError(true);
      setStoryViewers([]);
      setStoryViewsCount(0);
      toast.error('تعذر تحميل المشاهدين والإعجابات الفعلية. تحقق من ترحيل بيانات مشاهدي الستوري.');
    } finally {
      if (currentStory?.id === storyId) setStoryViewsLoading(false);
    }
  };

  const handleCloseStoryViews = () => {
    storyViewsRequestRef.current += 1;
    if (storyViewsChannelRef.current) {
      void supabase.removeChannel(storyViewsChannelRef.current);
      storyViewsChannelRef.current = null;
    }
    setStoryViewsOpen(false);
    setViewerRowMenuOpen(false);
    setViewerReportTarget(null);
    setIsPaused(storyViewsWasPausedRef.current);
    if (storyVideoWasPlayingRef.current) {
      void storyVideoRef.current?.play().catch(error => {
        console.warn('[story viewer] تعذرت متابعة تشغيل الفيديو بعد إغلاق المشاهدات:', error);
      });
    }
    storyVideoWasPlayingRef.current = false;
  };

  const handleOpenViewerReport = (viewer: StoryViewerEntry) => {
    if (!isStoryOwner || viewer.user_id === userId) return;
    setViewerReportTarget(viewer);
    setViewerReportCategory('spam');
    setViewerReportDetails('');
  };

  const handleSubmitViewerReport = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const target = viewerReportTarget;
    if (!target || !isStoryOwner || target.user_id === userId || !supabaseConfigured || viewerReportBusy) return;

    setViewerReportBusy(true);
    try {
      const { error } = await supabase.from('user_reports').insert({
        reporter_id: userId,
        reported_user_id: target.user_id,
        category: viewerReportCategory,
        details: viewerReportDetails.trim(),
      });
      if (error) {
        if (error.code === '23505') throw new Error('سبق أن أبلغت عن هذا الحساب.');
        throw error;
      }
      toast.success('تم إرسال البلاغ لمراجعة الحساب.');
      setViewerReportTarget(null);
    } catch (error) {
      console.error('[story views] تعذر إرسال بلاغ الحساب:', error);
      toast.error(error instanceof Error ? error.message : 'تعذر إرسال البلاغ. تأكد من تطبيق تحديث إجراءات مشاهدي الستوري.');
    } finally {
      setViewerReportBusy(false);
    }
  };

  const handleReportStory = async () => {
    const storyId = typeof currentStory?.id === 'string' ? currentStory.id : '';
    const reportedUserId = typeof currentStory?.user_id === 'string' ? currentStory.user_id : '';
    setShowMenu(false);

    if (!storyId || !reportedUserId || !userId || reportedUserId === userId) {
      toast.error('تعذر تحديد الستوري للإبلاغ عنها.');
      return;
    }

    if (!supabaseConfigured) {
      toast.error('تعذر إرسال البلاغ لعدم توفر الاتصال بقاعدة البيانات.');
      return;
    }

    const reason = window.prompt('ما سبب الإبلاغ عن هذه الستوري؟');
    if (reason === null) return;

    const normalizedReason = reason.trim();
    if (!normalizedReason) {
      toast.error('اكتب سبباً للإبلاغ عن الستوري.');
      return;
    }
    if (normalizedReason.length > 1000) {
      toast.error('يجب ألا يتجاوز سبب البلاغ 1000 حرف.');
      return;
    }

    try {
      const { error } = await supabase.from('story_reports').insert({
        story_id: storyId,
        reporter_id: userId,
        reported_user_id: reportedUserId,
        reason: normalizedReason,
      });

      if (error?.code === '23505') {
        toast.info('سبق أن أبلغت عن هذه الستوري.');
        return;
      }
      if (error) throw error;

      toast.success('تم إرسال البلاغ لمراجعته.');
    } catch (error) {
      console.error('[story report] تعذر إرسال البلاغ:', error);
      const code = (error as { code?: string } | null)?.code;
      if (code === '42P01' || code === 'PGRST205') {
        toast.error('جدول بلاغات القصص غير مهيأ. طبّق migration 20261117000000_story_reports.sql على Supabase.');
      } else if (code === '42501' || code === 'PGRST301') {
        toast.error('تعذر إرسال البلاغ بسبب صلاحيات قاعدة البيانات.');
      } else {
        toast.error('تعذر إرسال البلاغ. حاول مرة أخرى.');
      }
    }
  };

  const handleBlockStoryViewer = async (viewer: StoryViewerEntry) => {
    if (!isStoryOwner || viewer.user_id === userId || !supabaseConfigured || viewerActionBusyId) return;
    const name = displayName(viewer.viewer);
    if (!window.confirm(`هل تريد حظر ${name}؟ سيُمنع من مشاهدة قصصك والتواصل معك.`)) return;

    setViewerActionBusyId(viewer.user_id);
    try {
      const { error } = await supabase.rpc('aani_block_user', { p_blocked_user_id: viewer.user_id });
      if (error) throw error;
      const wasVisible = storyViewers.some(item => item.user_id === viewer.user_id && item.is_viewer !== false);
      setStoryViewers(current => current.filter(item => item.user_id !== viewer.user_id));
      if (wasVisible) setStoryViewsCount(count => Math.max(0, count - 1));
      toast.success('تم حظر الحساب ومنع التواصل وإزالة المتابعة والأصدقاء المقربين المتبادلة.');
    } catch (error) {
      console.error('[story views] تعذر حظر الحساب:', error);
      toast.error(error instanceof Error ? error.message : 'تعذر حظر الحساب. تحقق من تطبيق تحديث إجراءات مشاهدي الستوري.');
    } finally {
      setViewerActionBusyId(null);
    }
  };

  const handleHideStoryFromViewer = async (viewer: StoryViewerEntry) => {
    if (!isStoryOwner || viewer.user_id === userId || !supabaseConfigured || viewerActionBusyId) return;
    const name = displayName(viewer.viewer);
    if (!window.confirm(`إخفاء قصصك المستقبلية عن ${name}؟ لن تُحذف مشاهداته السابقة.`)) return;

    setViewerActionBusyId(viewer.user_id);
    try {
      const { error } = await supabase.rpc('aani_hide_story_from_user', { p_hidden_user_id: viewer.user_id });
      if (error) throw error;
      toast.success('تم حفظ إخفاء قصصك المستقبلية عن هذا الحساب. لم تُحذف مشاهداته السابقة.');
    } catch (error) {
      console.error('[story views] تعذر إخفاء القصص عن الحساب:', error);
      toast.error(error instanceof Error ? error.message : 'تعذر حفظ إعداد الإخفاء. تحقق من تطبيق تحديث إجراءات مشاهدي الستوري.');
    } finally {
      setViewerActionBusyId(null);
    }
  };

  const handleToggleStoryViewerFollow = async (viewer: StoryViewerEntry) => {
    if (!isStoryOwner || viewer.user_id === userId || !supabaseConfigured || viewerActionBusyId) return;

    setViewerActionBusyId(viewer.user_id);
    try {
      if (viewer.is_following) {
        const { error } = await supabase
          .from('follows')
          .delete()
          .eq('follower_id', userId)
          .eq('following_id', viewer.user_id);
        if (error) throw error;
        setStoryViewers(current => current.map(item => item.user_id === viewer.user_id
          ? { ...item, is_following: false, follow_request_pending: false }
          : item));
        toast.success('تم إلغاء المتابعة');
        return;
      }

      if (viewer.follow_request_pending) {
        const { error } = await supabase
          .from('follow_requests')
          .delete()
          .eq('requester_id', userId)
          .eq('recipient_id', viewer.user_id);
        if (error) throw error;
        setStoryViewers(current => current.map(item => item.user_id === viewer.user_id
          ? { ...item, follow_request_pending: false }
          : item));
        toast.success('تم إلغاء طلب المتابعة');
        return;
      }

      if (viewer.viewer?.is_private) {
        const { error } = await supabase.from('follow_requests').insert({
          requester_id: userId,
          recipient_id: viewer.user_id,
        });
        if (error && error.code !== '23505') throw error;
        setStoryViewers(current => current.map(item => item.user_id === viewer.user_id
          ? { ...item, follow_request_pending: true }
          : item));
        toast.success(error ? 'سبق إرسال طلب المتابعة' : 'تم إرسال طلب المتابعة');
        return;
      }

      const { error } = await supabase.from('follows').insert({
        follower_id: userId,
        following_id: viewer.user_id,
      });
      if (error && error.code !== '23505') throw error;
      setStoryViewers(current => current.map(item => item.user_id === viewer.user_id
        ? { ...item, is_following: true, follow_request_pending: false }
        : item));
      toast.success(error ? 'الحساب متابَع بالفعل' : 'تمت متابعة الحساب');
    } catch (error) {
      console.error('[story views] تعذر تحديث المتابعة:', error);
      toast.error(error instanceof Error ? error.message : 'تعذر تحديث حالة المتابعة. تحقق من الاتصال والصلاحيات.');
    } finally {
      setViewerActionBusyId(null);
    }
  };

  const handleToggleLike = async () => {
    if (!supabaseConfigured || !currentStory || isStoryOwner || isLikeSaving) return;
    const storyId = currentStory.id;
    setIsLikeSaving(true);

    try {
      if (isLiked) {
        const { error } = await supabase
          .from('story_likes')
          .delete()
          .eq('story_id', storyId)
          .eq('user_id', userId);
        if (error) throw error;
        setIsLiked(false);
        toast.success('تم إلغاء الإعجاب');
        return;
      }

      // 1) حفظ الإعجاب أولاً: لا تُعلن الواجهة النجاح قبل تأكيد صف story_likes.
      //    إشعار صاحب القصة يُنشئه مشغّل قاعدة البيانات (20270129000000)
      //    بعد الإدراج، فلا إدخال يدوي هنا (كان يبتلع أي فشل بصمت).
      const { error } = await supabase
        .from('story_likes')
        .upsert(
          { story_id: storyId, user_id: userId },
          { onConflict: 'story_id,user_id', ignoreDuplicates: true },
        );
      if (error) throw error;
      setIsLiked(true);

      // 2) كل من أعجب بقصة يُحتسب مشاهداً: طلب مستقل لا يُلغي الإعجاب
      //    ولا يؤخّر تأكيده إن فشل تسجيل المشاهدة.
      void supabase
        .rpc('aani_record_story_view', { p_story_id: storyId })
        .then(({ error: viewError }) => {
          if (viewError) console.warn('[story views] تعذر تسجيل مشاهدة المعجب:', viewError);
        })
        .catch(viewError => {
          console.warn('[story views] تعذر تسجيل مشاهدة المعجب:', viewError);
        });

      toast.success('تم الإعجاب بالستوري');
    } catch (error) {
      console.error('[story likes] تعذر حفظ الإعجاب:', error);
      toast.error('تعذر حفظ الإعجاب. حاول مرة أخرى.');
    } finally {
      setIsLikeSaving(false);
    }
  };

  const handleSendReply = async (customContent?: string) => {
    const textToSend = (customContent ?? replyText).trim();
    if (!supabaseConfigured || !currentStory || isStoryOwner || !textToSend || isSendingReply) return;

    setIsSendingReply(true);
    try {
      // رد الستوري = إشعار فقط. لا رسالة خاصة ولا صف في messages، وبالتالي
      // لا اعتماد على مشغّل قاعدة البيانات الذي كان يراقب رسائل الستوري.
      const thumbnailUrl = currentStory.thumbnail_url
        ?? (currentStory.media_type === 'image' ? currentStory.media_url : null);
      const metadata = {
        kind: 'story_reply',
        story_id: currentStory.id,
        story_reply_text: textToSend,
        story_thumbnail_url: thumbnailUrl,
        story_media_type: currentStory.media_type,
        story_owner_id: currentStory.user_id,
      };
      const payload = {
        user_id: currentStory.user_id,
        actor_id: userId,
        type: 'reply',
        content: textToSend,
        reference_id: currentStory.id,
        entity_id: currentStory.id,
        content_kind: 'story',
        metadata,
      };

      let { error } = await supabase.from('notifications').insert(payload);
      // توافق مؤقت مع قاعدة لم يُطبَّق عليها ترحيل metadata/content_kind:
      // نحاول من دون الحقلين بدل إفشال الرد بالكامل.
      if (error && /metadata|content_kind/i.test(error.message || '')) {
        const { metadata: _metadata, content_kind: _contentKind, ...legacyPayload } = payload;
        void _metadata;
        void _contentKind;
        ({ error } = await supabase.from('notifications').insert(legacyPayload));
      }
      if (error) throw error;

      setReplyText('');
      toast.success('تم إرسال الرد إلى صاحب الستوري');
    } catch (error) {
      console.error('[story replies] تعذر حفظ إشعار الرد:', error);
      toast.error('تعذر إرسال الرد. تحقق من الاتصال وحاول مرة أخرى.');
    } finally {
      setIsSendingReply(false);
    }
  };

  return {
    handleOpenStoryViews,
    handleCloseStoryViews,
    handleOpenViewerReport,
    handleSubmitViewerReport,
    handleReportStory,
    handleBlockStoryViewer,
    handleHideStoryFromViewer,
    handleToggleStoryViewerFollow,
    handleToggleLike,
    handleSendReply,
  };
}
