import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { MessageCircle, X } from 'lucide-react';
import { toast } from 'sonner';

import CommentComposer from './comments/CommentComposer';
import CommentsList from './comments/CommentsList';
import type { CommentComposerProfile, MentionCandidate } from './comments/types';
import {
  countComments,
  findCommentById,
  insertCommentIntoTree,
  patchCommentInTree,
  removeCommentFromTree,
  replaceCommentInTree,
} from '../lib/comments/tree';
import {
  fetchCommentsWithReplies,
  syncCommentCount,
  toggleCommentDislike,
  toggleCommentLike,
  uploadCommentImage,
  type CommentWithDetails,
} from '../lib/interactions';
import { handleAppError } from '../lib/appErrors';
import { supabase, supabaseConfigured, storageBucket } from '../lib/supabase';
import { extractMentions, findActiveMention, type MentionQuery } from '../lib/mentions';
import { useBottomSheetDismiss } from '../hooks/useBottomSheetDismiss';
import {
  isMissingOptionalModerationAction,
  isMissingOptionalModerationRelation,
  isOptionalModerationRelationUnavailable,
  markOptionalModerationRelationUnavailable,
  readLocalBlockedUserIds,
  readLocalCommentHideIds,
  readLocalRestrictedUserIds,
  writeLocalBlockedUserIds,
  writeLocalCommentHideIds,
  writeLocalRestrictedUserIds,
} from '../lib/comments/localModeration';

interface CommentsDrawerProps {
  postId: string;
  currentUserId: string;
  isOpen: boolean;
  onClose: () => void;
  initialCommentsCount?: number;
  initialCommentId?: string | null;
}

type SupabaseErrorDetails = {
  message?: string;
  code?: string;
  details?: string;
  hint?: string;
};

const getErrorDetails = (error: unknown): SupabaseErrorDetails => {
  if (error instanceof Error) {
    const details = error as Error & SupabaseErrorDetails;

    return {
      message: details.message,
      code: details.code,
      details: details.details,
      hint: details.hint,
    };
  }

  if (error && typeof error === 'object') {
    const details = error as SupabaseErrorDetails;

    return {
      message: details.message,
      code: details.code,
      details: details.details,
      hint: details.hint,
    };
  }

  return {
    message: typeof error === 'string' ? error : 'حدث خطأ غير معروف',
  };
};

const formatCommentsTitle = (count: number): string => {
  if (count === 0) return 'التعليقات';
  if (count === 1) return 'تعليق واحد';
  if (count === 2) return 'تعليقان';
  if (count <= 10) return `${count} تعليقات`;
  return `${count} تعليقاً`;
};

const buildSavedComment = (
  row: Record<string, unknown>,
  profiles: CommentWithDetails['profiles'],
): CommentWithDetails => ({
  id: String(row.id),
  post_id: String(row.post_id ?? ''),
  user_id: String(row.user_id ?? ''),
  parent_id: row.parent_id ? String(row.parent_id) : null,
  content: String(row.content ?? ''),
  image_url: row.image_url ? String(row.image_url) : null,
  created_at: String(row.created_at ?? new Date().toISOString()),
  profiles,
  is_pinned: Boolean(row.is_pinned),
  is_hidden_by_me: false,
  likes_count: 0,
  dislikes_count: 0,
  is_liked: false,
  is_disliked: false,
  replies: [],
});

const filterHiddenComments = (
  items: CommentWithDetails[],
  blockedUserIds: Set<string>,
): CommentWithDetails[] =>
  items.flatMap((item) => {
    const visibleReplies = filterHiddenComments(item.replies ?? [], blockedUserIds);
    if (item.is_hidden_by_me || blockedUserIds.has(item.user_id)) {
      return visibleReplies.map((reply) => ({ ...reply, parent_id: null }));
    }
    return [{ ...item, replies: visibleReplies }];
  });

const copyText = async (text: string): Promise<void> => {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }

  const textarea = document.createElement('textarea');
  textarea.value = text;
  textarea.style.position = 'fixed';
  textarea.style.opacity = '0';
  document.body.appendChild(textarea);
  textarea.select();
  const copied = document.execCommand('copy');
  textarea.remove();
  if (!copied) throw new Error('Clipboard access is unavailable');
};

export const CommentsDrawer: React.FC<CommentsDrawerProps> = ({
  postId,
  currentUserId,
  isOpen,
  onClose,
  initialCommentsCount = 0,
  initialCommentId,
}) => {
  const [comments, setComments] = useState<CommentWithDetails[]>([]);
  const [postOwnerId, setPostOwnerId] = useState<string | null>(null);
  const [restrictedUserIds, setRestrictedUserIds] = useState<Set<string>>(new Set());
  const [blockedUserIds, setBlockedUserIds] = useState<Set<string>>(new Set());
  const [content, setContent] = useState('');
  const [replyingTo, setReplyingTo] = useState<CommentWithDetails | null>(null);
  const [selectedImage, setSelectedImage] = useState<File | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [commentsError, setCommentsError] = useState<string | null>(null);
  const [commentAccess, setCommentAccess] = useState({ canRead: true, canComment: true, checking: true, failed: false });
  const [submitting, setSubmitting] = useState(false);
  const [pendingReactionIds, setPendingReactionIds] = useState<
    Record<string, boolean>
  >({});
  const [pendingDeleteIds, setPendingDeleteIds] = useState<
    Record<string, boolean>
  >({});
  const [pendingEditIds, setPendingEditIds] = useState<Record<string, boolean>>({});
  const [pendingActionIds, setPendingActionIds] = useState<Record<string, boolean>>({});
  const [showStickerPicker, setShowStickerPicker] = useState(false);
  const [storyOwners, setStoryOwners] = useState<Set<string>>(new Set());
  const [peopleDirectory, setPeopleDirectory] = useState<MentionCandidate[]>([]);
  const [mentionQuery, setMentionQuery] = useState<MentionQuery | null>(null);
  const [mentionIndex, setMentionIndex] = useState(0);
  const {
    dragOffset,
    dragging,
    onClickCapture: onHandleClickCapture,
    onPointerDown: onHandlePointerDown,
    onTouchStart: onHandleTouchStart,
    onTouchMove: onHandleTouchMove,
    onTouchEnd: onHandleTouchEnd,
    onTouchCancel: onHandleTouchCancel,
  } = useBottomSheetDismiss(isOpen, onClose);

  // أشخاص يمكن ذكرهم: من أتابعهم ومن يتابعونني (بدون مستخدمين عشوائيين)
  useEffect(() => {
    if (!isOpen || !supabaseConfigured || !currentUserId) return;

    let active = true;

    void (async () => {
      try {
        const { data: relations } = await supabase
          .from('follows')
          .select('follower_id, following_id')
          .or(`follower_id.eq.${currentUserId},following_id.eq.${currentUserId}`)
          .limit(2000);

        const ids = new Set<string>();
        (relations || []).forEach((row: { follower_id: string; following_id: string }) => {
          if (row.follower_id === currentUserId) ids.add(row.following_id);
          else if (row.following_id === currentUserId) ids.add(row.follower_id);
        });
        ids.delete(currentUserId);

        if (ids.size === 0) {
          if (active) setPeopleDirectory([]);
          return;
        }

        const { data } = await supabase
          .from('profiles')
          .select('id, username, full_name, avatar_url')
          .in('id', Array.from(ids))
          .limit(500);

        if (active) setPeopleDirectory((data || []) as MentionCandidate[]);
      } catch (error) {
        console.warn('Error loading mention candidates:', error);
      }
    })();

    return () => {
      active = false;
    };
  }, [isOpen, currentUserId]);

  const commentIdsRef = useRef<Set<string>>(new Set());

  const [currentUser, setCurrentUser] = useState<CommentComposerProfile>(null);

  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  // إزالة الاعتمادية الحركية لتجنب الحلقة اللانهائية
  const loadComments = useCallback(async (showLoadingSpinner = true) => {
    if (!postId) return;

    if (showLoadingSpinner) {
      setLoading(true);
    }
    setCommentsError(null);

    try {
      const data = await fetchCommentsWithReplies(postId, currentUserId);
      setComments(data);
      // ربط عدّاد المنشور بالعدد الحقيقي للتعليقات المقترنة به في قاعدة البيانات
      syncCommentCount(postId, currentUserId, countComments(data));
    } catch (error: unknown) {
      console.error('Error fetching comments:', getErrorDetails(error));
      setCommentsError('تعذر تحميل التعليقات من قاعدة البيانات');
    } finally {
      setLoading(false);
    }
  }, [postId, currentUserId]);

  useEffect(() => {
    if (!isOpen) {
      setCommentAccess({ canRead: true, canComment: true, checking: false, failed: false });
      return;
    }
    if (!postId || !currentUserId) {
      setCommentAccess({ canRead: false, canComment: false, checking: false, failed: true });
      return;
    }

    let active = true;
    setPostOwnerId(null);
    setRestrictedUserIds(new Set());
    setCommentAccess({ canRead: true, canComment: true, checking: true, failed: false });
    void (async () => {
      let postRow: {
        user_id: string;
        comments_disabled?: boolean;
        hide_comments?: boolean;
      } | null = null;
      let legacySchema = false;

      const settingsResult = await supabase
        .from('posts')
        .select('user_id, comments_disabled, hide_comments')
        .eq('id', postId)
        .maybeSingle();
      if (!settingsResult.error && settingsResult.data) {
        postRow = settingsResult.data as typeof postRow;
      } else if (settingsResult.error?.code === '42703' || settingsResult.error?.code === 'PGRST204') {
        const legacyResult = await supabase
          .from('posts')
          .select('user_id, comments_disabled')
          .eq('id', postId)
          .maybeSingle();
        if (!legacyResult.error && legacyResult.data) {
          postRow = legacyResult.data as typeof postRow;
          legacySchema = true;
        }
      }

      if (!active) return;
      if (!postRow) {
        setPostOwnerId(null);
        setCommentAccess({ canRead: false, canComment: false, checking: false, failed: true });
        return;
      }

      setPostOwnerId(postRow.user_id);
      const isOwner = postRow.user_id === currentUserId;
      const canRead = isOwner || postRow.hide_comments !== true;
      let canComment: boolean;
      if (legacySchema) {
        canComment = postRow.comments_disabled !== true;
      } else {
        const permissionResult = await supabase.rpc('aani_can_comment_on_post', {
          p_post_id: postId,
          p_commenter_id: currentUserId,
        });
        if (permissionResult.error) throw permissionResult.error;
        canComment = Boolean(permissionResult.data);
      }

      if (!active) return;
      setCommentAccess({ canRead, canComment, checking: false, failed: false });
    })().catch(error => {
      console.warn('[comments] تعذر التحقق من صلاحية التعليق:', error);
      if (active) setCommentAccess({ canRead: false, canComment: false, checking: false, failed: true });
    });

    return () => {
      active = false;
    };
  }, [isOpen, postId, currentUserId]);

  useEffect(() => {
    if (!isOpen || !currentUserId || postOwnerId !== currentUserId) {
      setRestrictedUserIds(new Set());
      return;
    }

    let active = true;
    const localRestrictedUserIds = readLocalRestrictedUserIds(currentUserId);
    setRestrictedUserIds(localRestrictedUserIds);

    if (!isOptionalModerationRelationUnavailable('user_restrictions')) {
      void (async () => {
        try {
          const { data, error } = await supabase
            .from('user_restrictions')
            .select('restricted_user_id')
            .eq('restricter_id', currentUserId);

          if (!active) return;
          if (error) {
            if (isMissingOptionalModerationRelation('user_restrictions', error)) {
              markOptionalModerationRelationUnavailable('user_restrictions');
            } else {
              console.warn('[comments] تعذر تحميل الحسابات المقيدة:', error);
            }
            return;
          }

          const merged = new Set([
            ...localRestrictedUserIds,
            ...(data ?? []).map(row => String(row.restricted_user_id)),
          ]);
          setRestrictedUserIds(merged);
          writeLocalRestrictedUserIds(currentUserId, merged);
        } catch (error) {
          if (isMissingOptionalModerationRelation('user_restrictions', error)) {
            markOptionalModerationRelationUnavailable('user_restrictions');
          } else {
            console.warn('[comments] تعذر تحميل الحسابات المقيدة:', error);
          }
        }
      })();
    }

    return () => {
      active = false;
    };
  }, [isOpen, currentUserId, postOwnerId]);

  useEffect(() => {
    setBlockedUserIds(readLocalBlockedUserIds(currentUserId));
  }, [currentUserId]);

  useEffect(() => {
    const ids = new Set<string>();

    const visit = (items: CommentWithDetails[]) => {
      items.forEach((item) => {
        ids.add(item.id);

        if (item.replies) {
          visit(item.replies);
        }
      });
    };

    visit(comments);
    commentIdsRef.current = ids;
  }, [comments]);

  useEffect(() => {
    if (!isOpen || !currentUserId) return;

    let cancelled = false;

    void (async () => {
      const { data, error } = await supabase
        .from('profiles')
        .select('full_name, username, avatar_url')
        .eq('id', currentUserId)
        .maybeSingle();

      if (cancelled) return;

      if (error) {
        console.error(
          'Error fetching comment composer profile:',
          getErrorDetails(error),
        );
        return;
      }

      if (data) {
        setCurrentUser(data as typeof currentUser);
      }
    })().catch((error: unknown) => {
      if (!cancelled) {
        console.error(
          'Error fetching comment profile:',
          getErrorDetails(error),
        );
      }
    });

    void loadComments(true);

    return () => {
      cancelled = true;
    };
  }, [isOpen, postId, currentUserId, loadComments, initialCommentsCount]);

  useEffect(() => {
    if (!isOpen || !initialCommentId || loading || !commentAccess.canRead) return undefined;
    const frame = window.requestAnimationFrame(() => {
      document.getElementById(`comment-${initialCommentId}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [commentAccess.canRead, comments, initialCommentId, isOpen, loading]);

  useEffect(() => {
    if (!isOpen) return;

    const refreshForReaction = (payload: {
      new?: unknown;
      old?: unknown;
    }) => {
      const row = (payload.new ?? payload.old ?? {}) as {
        comment_id?: string;
      };

      if (
        row.comment_id &&
        commentIdsRef.current.has(String(row.comment_id))
      ) {
        void loadComments(false);
      }
    };

    const channel = supabase
      .channel(`comments_drawer_${postId}`)
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'comments',
          filter: `post_id=eq.${postId}`,
        },
        () => {
          void loadComments(false);
        },
      )
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'comment_likes',
        },
        refreshForReaction,
      )
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'comment_dislikes',
        },
        refreshForReaction,
      )
      .subscribe((status, error) => {
        if (error || status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
          handleAppError(
            'فشل تحديث التعليقات مباشرة',
            error || new Error(`Comments realtime channel ${status}`),
            'تعذر تحديث التعليقات مباشرة. تحقق من الاتصال.',
          );
        }
      });

    return () => {
      void supabase.removeChannel(channel);
    };
  }, [isOpen, postId, loadComments]);

  useEffect(() => {
    if (!isOpen) return;

    // جلب أصحاب الستوري النشط لإطار أحمر حول صورهم في التعليقات
    if (!supabaseConfigured) return;

    let cancelled = false;

    void (async () => {
      try {
        const { data } = await supabase
          .from('stories')
          .select('user_id')
          .gt('expires_at', new Date().toISOString())
          .limit(1000);

        if (cancelled) return;

        setStoryOwners(
          new Set(
            ((data ?? []) as { user_id: string }[]).map((row) =>
              String(row.user_id),
            ),
          ),
        );
      } catch (error) {
        if (!cancelled) {
          console.error('Error fetching active story owners:', error);
          setStoryOwners(new Set());
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [isOpen, postId]);

  useEffect(() => {
    if (!selectedImage) {
      setPreviewUrl(null);
      return;
    }

    const objectUrl = URL.createObjectURL(selectedImage);
    setPreviewUrl(objectUrl);

    return () => URL.revokeObjectURL(objectUrl);
  }, [selectedImage]);

  useEffect(() => {
    if (!textareaRef.current) return;

    textareaRef.current.style.height = '0px';
    textareaRef.current.style.height =
      `${Math.min(textareaRef.current.scrollHeight, 130)}px`;
  }, [content]);

  const totalComments = useMemo(() => {
    if (commentsError || (loading && comments.length === 0)) {
      return initialCommentsCount;
    }
    return countComments(comments);
  }, [comments, commentsError, initialCommentsCount, loading]);
  const visibleComments = useMemo(
    () => filterHiddenComments(comments, blockedUserIds),
    [blockedUserIds, comments],
  );

  // قائمة مرشّحي المنشن: المتابَعون/المتابِعون + أصحاب التعليقات الحالية
  const mentionCandidates = useMemo(() => {
    const map = new Map<string, MentionCandidate>();

    peopleDirectory.forEach((person) => map.set(person.id, person));

    const visit = (items: CommentWithDetails[]) => {
      items.forEach((item) => {
        if (item.user_id && item.profiles) {
          map.set(item.user_id, {
            id: item.user_id,
            username: item.profiles.username ?? null,
            full_name: item.profiles.full_name ?? null,
            avatar_url: item.profiles.avatar_url ?? null,
          });
        }

        if (item.replies) visit(item.replies);
      });
    };

    visit(comments);
    map.delete(currentUserId);

    return Array.from(map.values());
  }, [peopleDirectory, comments, currentUserId]);

  const mentionSuggestions = useMemo(() => {
    if (!mentionQuery) return [] as MentionCandidate[];

    const needle = mentionQuery.query.trim().toLowerCase();

    return mentionCandidates
      .filter((person) => {
        const username = (person.username ?? '').toLowerCase();
        const fullName = (person.full_name ?? '').toLowerCase();
        if (!needle) return true;
        return username.includes(needle) || fullName.includes(needle);
      })
      .slice(0, 6);
  }, [mentionCandidates, mentionQuery]);

  const insertMention = () => {
    const prefix = content && !content.endsWith(' ') ? `${content} ` : content;

    if (replyingTo) {
      const token = `@${replyingTo.profiles?.username || 'user'} `;
      setContent(`${prefix}${token}`);
      setMentionQuery(null);
    } else {
      setContent(`${prefix}@`);
      setMentionQuery({ query: '', start: prefix.length, end: prefix.length + 1 });
      setMentionIndex(0);
    }

    window.setTimeout(() => textareaRef.current?.focus(), 0);
  };

  const handleComposerChange = (event: React.ChangeEvent<HTMLTextAreaElement>) => {
    const value = event.target.value;
    setContent(value);

    const caret = event.target.selectionStart ?? value.length;
    setMentionQuery(findActiveMention(value, caret));
    setMentionIndex(0);
  };

  const applyMentionSuggestion = (person: MentionCandidate) => {
    const token = `@${person.username || person.full_name || 'user'}`;

    setContent((prev) => {
      const active = mentionQuery;
      if (!active) {
        return `${prev}${prev && !prev.endsWith(' ') ? ' ' : ''}${token} `;
      }

      const before = prev.slice(0, active.start);
      const after = prev.slice(active.end);
      return `${before}${token} ${after.replace(/^\s+/, '')}`;
    });

    setMentionQuery(null);
    window.setTimeout(() => textareaRef.current?.focus(), 0);
  };

  const insertSticker = (sticker: string) => {
    setContent(
      (prev) => `${prev}${prev && !prev.endsWith(' ') ? ' ' : ''}${sticker}`,
    );

    setShowStickerPicker(false);
    setMentionQuery(null);
    window.setTimeout(() => textareaRef.current?.focus(), 0);
  };

  const handleSubmit = async () => {
    const nextContent = content.trim();

    if (submitting) return;
    if (!nextContent && !selectedImage) return;

    if (!postId?.trim()) {
      toast.error('تعذر تحديد المنشور الذي تريد التعليق عليه');
      return;
    }

    if (!currentUserId?.trim()) {
      toast.error('تعذر تحديد حسابك. سجّل الدخول ثم حاول مرة أخرى.');
      return;
    }

    if (commentAccess.checking || !commentAccess.canComment) {
      toast.error('لا تملك صلاحية التعليق على هذا المنشور.');
      return;
    }

    if (nextContent.length > 2000) {
      toast.error('التعليق طويل جدًا؛ الحد الأقصى 2000 حرف');
      return;
    }

    setSubmitting(true);

    const parentId = replyingTo?.id ?? null;
    const optimisticId = `temp-${crypto.randomUUID()}`;

    // تعليق مؤقت يظهر فورًا في القائمة قبل اكتمال الحفظ (Optimistic UI)
    const optimisticComment: CommentWithDetails = {
      id: optimisticId,
      post_id: postId,
      user_id: currentUserId,
      parent_id: parentId,
      content: nextContent,
      image_url: previewUrl,
      created_at: new Date().toISOString(),
      profiles: currentUser
        ? {
            full_name: currentUser.full_name,
            username: currentUser.username,
            avatar_url: currentUser.avatar_url,
          }
        : null,
      likes_count: 0,
      dislikes_count: 0,
      is_liked: false,
      is_disliked: false,
      is_pinned: false,
      is_hidden_by_me: false,
      replies: [],
    };

    const optimisticList = insertCommentIntoTree(comments, optimisticComment);
    setComments(optimisticList);
    syncCommentCount(postId, currentUserId, countComments(optimisticList));

    setContent('');
    setMentionQuery(null);
    setSelectedImage(null);
    setPreviewUrl(null);
    setReplyingTo(null);
    setShowStickerPicker(false);

    let uploadedImage: Awaited<
      ReturnType<typeof uploadCommentImage>
    > | null = null;

    let commentSaved = false;

    try {
      if (selectedImage) {
        uploadedImage = await uploadCommentImage(
          selectedImage,
          currentUserId,
        );

        if (!uploadedImage?.publicUrl) {
          throw new Error('لم يتم الحصول على رابط الصورة بعد رفعها');
        }
      }

      const payload: Record<string, string | null> = {
        post_id: postId,
        user_id: currentUserId,
        content: nextContent,
        parent_id: parentId,
      };

      if (uploadedImage?.publicUrl) {
        payload.image_url = uploadedImage.publicUrl;
      }

      const { data: savedRow, error: insertError } = await supabase
        .from('comments')
        .insert(payload)
        .select('id, post_id, user_id, parent_id, content, image_url, created_at')
        .maybeSingle();

      if (insertError) throw insertError;
      if (!savedRow) throw new Error('لم يُعَد صف التعليق بعد الحفظ');

      commentSaved = true;

      const realComment: CommentWithDetails = buildSavedComment(
        savedRow as Record<string, unknown>,
        optimisticComment.profiles,
      );

      // استبدال التعليق المؤقت بالصف المحفوظ فعليًا في قاعدة البيانات
      setComments((previous) =>
        replaceCommentInTree(previous, optimisticId, realComment),
      );

      // إشعار الرد: يذهب حصريًا لصاحب التعليق الأصلي
      if (replyingTo && replyingTo.user_id !== currentUserId) {
        void supabase
          .from('notifications')
          .insert({
            user_id: replyingTo.user_id,
            actor_id: currentUserId,
            type: 'reply',
            content: `${currentUser?.full_name || 'مستخدم'} رد على تعليقك`,
            comment_id: replyingTo.id,
          });
      }

      // إشعارات المنشن: لكل شخص مذكور في التعليق (مرة واحدة لكل شخص)
      const mentionTokens = extractMentions(nextContent);
      if (mentionTokens.length > 0) {
        const notified = new Set<string>([currentUserId, replyingTo?.user_id ?? '']);

        mentionCandidates.forEach((person) => {
          const username = (person.username ?? '').toLowerCase();
          const fullName = (person.full_name ?? '').toLowerCase();
          const isMentioned = mentionTokens.some(
            (token) => token === username || token === fullName,
          );

          if (!isMentioned || notified.has(person.id)) return;
          notified.add(person.id);

          void supabase
            .from('notifications')
            .insert({
              user_id: person.id,
              actor_id: currentUserId,
              type: 'mention',
              content: `${currentUser?.full_name || 'مستخدم'} ذكرك في تعليق`,
              comment_id: realComment.id,
            });
        });
      }
    } catch (err: unknown) {
      const error = getErrorDetails(err);

      // إزالة التعليق المؤقت عند فشل الحفظ الفعلي
      setComments((previous) => removeCommentFromTree(previous, optimisticId));

      if (!commentSaved && uploadedImage?.path) {
        void supabase.storage.from(storageBucket).remove([uploadedImage.path]);
      }

      toast.error(`تعذر حفظ التعليق${error.message ? `: ${error.message}` : ''}`);

      await loadComments(false);
    } finally {
      setSubmitting(false);
    }
  };

  const runReaction = async (
    commentId: string,
    update: () => Promise<void>,
  ): Promise<boolean> => {
    if (pendingReactionIds[commentId]) return false;

    setPendingReactionIds((prev) => ({
      ...prev,
      [commentId]: true,
    }));

    try {
      await update();
      await loadComments(false);
      return true;
    } catch (error: unknown) {
      console.error('Comment reaction failed:', getErrorDetails(error));
      toast.error('تعذر تحديث التفاعل');
      return false;
    } finally {
      setPendingReactionIds((prev) => {
        const next = { ...prev };
        delete next[commentId];
        return next;
      });
    }
  };

  // تحديث فوري لحالة التفاعل في القائمة (Optimistic UI) قبل إرسال الطلب
  const applyReactionOptimistically = (
    commentId: string,
    patch: Partial<CommentWithDetails>,
  ) => {
    setComments((previous) => patchCommentInTree(previous, commentId, patch));
  };

  const handleToggleLike = async (commentId: string, isLiked: boolean) => {
    if (pendingReactionIds[commentId]) return;

    const target = findCommentById(comments, commentId);
    if (!target) return;

    const nextLiked = !isLiked;
    applyReactionOptimistically(commentId, {
      is_liked: nextLiked,
      likes_count: Math.max(0, (target.likes_count ?? 0) + (nextLiked ? 1 : -1)),
      is_disliked: nextLiked ? false : !!target.is_disliked,
      dislikes_count: nextLiked
        ? Math.max(0, (target.dislikes_count ?? 0) - (target.is_disliked ? 1 : 0))
        : target.dislikes_count ?? 0,
    });

    const ok = await runReaction(commentId, () =>
      toggleCommentLike(commentId, currentUserId, isLiked),
    );

    if (!ok) {
      // إعادة الحالة السابقة عند فشل الحفظ
      applyReactionOptimistically(commentId, {
        is_liked: !!target.is_liked,
        likes_count: target.likes_count ?? 0,
        is_disliked: !!target.is_disliked,
        dislikes_count: target.dislikes_count ?? 0,
      });
      return;
    }

    // إشعار حقيقي لصاحب التعليق عند الإعجاب فقط (وليس عند إلغاء الإعجاب)
    if (isLiked || target.user_id === currentUserId) return;

    void supabase
      .from('notifications')
      .insert({
        user_id: target.user_id,
        actor_id: currentUserId,
        type: 'like',
        content: `${currentUser?.full_name || 'مستخدم'} قام بالإعجاب بتعليقك`,
        comment_id: target.id,
      });
  };

  const handleToggleDislike = async (commentId: string, isDisliked: boolean) => {
    if (pendingReactionIds[commentId]) return;

    const target = findCommentById(comments, commentId);
    if (!target) return;

    const nextDisliked = !isDisliked;
    applyReactionOptimistically(commentId, {
      is_disliked: nextDisliked,
      dislikes_count: Math.max(
        0,
        (target.dislikes_count ?? 0) + (nextDisliked ? 1 : -1),
      ),
      is_liked: nextDisliked ? false : !!target.is_liked,
      likes_count: nextDisliked
        ? Math.max(0, (target.likes_count ?? 0) - (target.is_liked ? 1 : 0))
        : target.likes_count ?? 0,
    });

    const ok = await runReaction(commentId, () =>
      toggleCommentDislike(commentId, currentUserId, isDisliked),
    );

    if (!ok) {
      applyReactionOptimistically(commentId, {
        is_disliked: !!target.is_disliked,
        dislikes_count: target.dislikes_count ?? 0,
        is_liked: !!target.is_liked,
        likes_count: target.likes_count ?? 0,
      });
    }
  };

  const handleEditComment = async (
    comment: CommentWithDetails,
    nextContent: string,
  ): Promise<boolean> => {
    const normalized = nextContent.trim();
    if (comment.user_id !== currentUserId || pendingEditIds[comment.id]) return false;
    if (normalized.length > 2000 || (!normalized && !comment.image_url)) {
      toast.error('أدخل نصاً صالحاً للتعليق');
      return false;
    }

    setPendingEditIds((prev) => ({ ...prev, [comment.id]: true }));
    try {
      const { error } = await supabase.rpc('aani_edit_comment', {
        p_comment_id: comment.id,
        p_content: normalized,
      });
      if (error) throw error;
      toast.success('تم تعديل التعليق');
      await loadComments(false);
      return true;
    } catch (error: unknown) {
      console.error('[comments] تعذر تعديل التعليق:', error);
      toast.error('تعذر تعديل التعليق. تحقق من تطبيق تحديث إدارة التعليقات.');
      return false;
    } finally {
      setPendingEditIds((prev) => {
        const next = { ...prev };
        delete next[comment.id];
        return next;
      });
    }
  };

  const handleDeleteComment = async (comment: CommentWithDetails) => {
    const canDelete = comment.user_id === currentUserId || postOwnerId === currentUserId;
    if (!canDelete || pendingDeleteIds[comment.id] || !window.confirm('هل تريد حذف هذا التعليق؟')) return;

    setPendingDeleteIds((prev) => ({ ...prev, [comment.id]: true }));
    try {
      const { error } = await supabase.rpc('aani_delete_comment', {
        p_comment_id: comment.id,
      });
      if (error) throw error;
      toast.success('تم حذف التعليق');
      await loadComments(false);
    } catch (error: unknown) {
      console.error('[comments] تعذر حذف التعليق:', error);
      toast.error('تعذر حذف التعليق. تحقق من صلاحيات الحساب وتحديث إدارة التعليقات.');
    } finally {
      setPendingDeleteIds((prev) => {
        const next = { ...prev };
        delete next[comment.id];
        return next;
      });
    }
  };

  const handleCopyComment = async (comment: CommentWithDetails) => {
    const text = comment.content.trim() || comment.image_url || '';
    if (!text) {
      toast.error('لا يوجد محتوى لنسخه');
      return;
    }
    try {
      await copyText(text);
      toast.success('تم نسخ التعليق');
    } catch (error) {
      console.warn('[comments] تعذر نسخ التعليق:', error);
      toast.error('تعذر النسخ؛ تحقق من أذونات الحافظة');
    }
  };

  const handleReportComment = async (comment: CommentWithDetails) => {
    if (!currentUserId || comment.user_id === currentUserId) return;
    const details = window.prompt('ما سبب الإبلاغ عن هذا التعليق؟');
    if (details === null) return;
    const normalizedDetails = details.trim();
    if (!normalizedDetails) {
      toast.error('اكتب سبباً للإبلاغ عن التعليق');
      return;
    }
    if (normalizedDetails.length > 1000) {
      toast.error('يجب ألا يتجاوز سبب البلاغ 1000 حرف');
      return;
    }

    try {
      const { error } = await supabase.from('comment_reports').insert({
        comment_id: comment.id,
        post_id: postId,
        reporter_id: currentUserId,
        reported_user_id: comment.user_id,
        category: 'other',
        details: normalizedDetails,
      });
      if (error?.code === '23505') {
        toast.info('سبق أن أبلغت عن هذا التعليق');
        return;
      }
      if (error) throw error;
      toast.success('تم إرسال البلاغ لمراجعته');
    } catch (error) {
      console.error('[comments] تعذر إرسال البلاغ:', error);
      toast.error('تعذر إرسال البلاغ. تحقق من تطبيق تحديث إدارة التعليقات.');
    }
  };

  const handleHideComment = async (comment: CommentWithDetails) => {
    if (!currentUserId || pendingActionIds[comment.id]) return;
    setPendingActionIds((prev) => ({ ...prev, [comment.id]: true }));

    const hiddenCommentIds = readLocalCommentHideIds(currentUserId);
    hiddenCommentIds.add(comment.id);
    writeLocalCommentHideIds(currentUserId, hiddenCommentIds);
    setComments((previous) => patchCommentInTree(previous, comment.id, { is_hidden_by_me: true }));

    try {
      if (!isOptionalModerationRelationUnavailable('comment_hides')) {
        const { error } = await supabase.from('comment_hides').insert({
          user_id: currentUserId,
          comment_id: comment.id,
        });
        if (error && error.code !== '23505') {
          if (isMissingOptionalModerationRelation('comment_hides', error)) {
            markOptionalModerationRelationUnavailable('comment_hides');
          } else {
            console.warn('[comments] تم حفظ الإخفاء محلياً فقط:', error);
          }
        }
      }
      toast.success(
        isOptionalModerationRelationUnavailable('comment_hides')
          ? 'تم إخفاء التعليق على هذا الجهاز'
          : 'تم إخفاء التعليق من قائمتك',
      );
    } catch (error) {
      if (isMissingOptionalModerationRelation('comment_hides', error)) {
        markOptionalModerationRelationUnavailable('comment_hides');
      } else {
        console.warn('[comments] تم حفظ الإخفاء محلياً فقط:', error);
      }
      toast.success('تم إخفاء التعليق على هذا الجهاز');
    } finally {
      setPendingActionIds((prev) => {
        const next = { ...prev };
        delete next[comment.id];
        return next;
      });
    }
  };

  const handleTogglePin = async (comment: CommentWithDetails) => {
    if (postOwnerId !== currentUserId || pendingActionIds[comment.id]) return;
    setPendingActionIds((prev) => ({ ...prev, [comment.id]: true }));
    try {
      const { error } = await supabase.rpc('aani_set_comment_pinned', {
        p_comment_id: comment.id,
        p_is_pinned: !comment.is_pinned,
      });
      if (error) throw error;
      toast.success(comment.is_pinned ? 'تم إلغاء تثبيت التعليق' : 'تم تثبيت التعليق');
      await loadComments(false);
    } catch (error) {
      console.error('[comments] تعذر تحديث تثبيت التعليق:', error);
      toast.error('تعذر تثبيت التعليق. تحقق من تطبيق تحديث إدارة التعليقات.');
    } finally {
      setPendingActionIds((prev) => {
        const next = { ...prev };
        delete next[comment.id];
        return next;
      });
    }
  };

  const handleBlockCommentAuthor = async (comment: CommentWithDetails) => {
    if (postOwnerId !== currentUserId || comment.user_id === currentUserId || pendingActionIds[comment.id]) return;
    const name = comment.profiles?.full_name || comment.profiles?.username || 'كاتب التعليق';
    if (!window.confirm(`هل تريد حظر ${name}؟ سيُمنع من التواصل معك.`)) return;

    const localBlockedUserIds = readLocalBlockedUserIds(currentUserId);
    localBlockedUserIds.add(comment.user_id);
    writeLocalBlockedUserIds(currentUserId, localBlockedUserIds);
    setBlockedUserIds(localBlockedUserIds);
    setPendingActionIds((prev) => ({ ...prev, [comment.id]: true }));

    try {
      const { error } = await supabase.rpc('aani_block_user', {
        p_blocked_user_id: comment.user_id,
      });
      if (error) throw error;
      toast.success('تم حظر الحساب');
      await loadComments(false);
    } catch (error) {
      if (isMissingOptionalModerationAction('aani_block_user', error)) {
        toast.success('تم حظر الحساب على هذا الجهاز');
      } else {
        console.warn('[comments] تم حفظ الحظر محلياً فقط:', error);
        toast.success('تم حظر الحساب على هذا الجهاز');
      }
    } finally {
      setPendingActionIds((prev) => {
        const next = { ...prev };
        delete next[comment.id];
        return next;
      });
    }
  };

  const handleToggleRestriction = async (userId: string, restricted: boolean) => {
    if (postOwnerId !== currentUserId || !userId || userId === currentUserId) return;
    const pendingId = userId;
    if (pendingActionIds[pendingId]) return;

    const localRestrictedUserIds = readLocalRestrictedUserIds(currentUserId);
    if (restricted) localRestrictedUserIds.add(userId);
    else localRestrictedUserIds.delete(userId);
    writeLocalRestrictedUserIds(currentUserId, localRestrictedUserIds);
    setRestrictedUserIds(localRestrictedUserIds);
    setPendingActionIds((prev) => ({ ...prev, [pendingId]: true }));

    try {
      if (!isOptionalModerationRelationUnavailable('user_restrictions')) {
        const { error } = await supabase.rpc('aani_set_user_restricted', {
          p_user_id: userId,
          p_restricted: restricted,
        });
        if (error) throw error;
        toast.success(restricted ? 'تم تقييد الحساب' : 'تم إلغاء تقييد الحساب');
      } else {
        toast.success(restricted ? 'تم تقييد الحساب على هذا الجهاز' : 'تم إلغاء التقييد على هذا الجهاز');
      }
    } catch (error) {
      if (isMissingOptionalModerationAction('aani_set_user_restricted', error)) {
        markOptionalModerationRelationUnavailable('user_restrictions');
      } else {
        console.warn('[comments] تم حفظ التقييد محلياً فقط:', error);
      }
      toast.success(restricted ? 'تم تقييد الحساب على هذا الجهاز' : 'تم إلغاء التقييد على هذا الجهاز');
    } finally {
      setPendingActionIds((prev) => {
        const next = { ...prev };
        delete next[pendingId];
        return next;
      });
    }
  };

  const handleComposerKeyDown = (
    event: React.KeyboardEvent<HTMLTextAreaElement>,
  ) => {
    if (mentionSuggestions.length > 0) {
      if (event.key === 'ArrowDown') {
        event.preventDefault();
        setMentionIndex((prev) => (prev + 1) % mentionSuggestions.length);
        return;
      }

      if (event.key === 'ArrowUp') {
        event.preventDefault();
        setMentionIndex(
          (prev) => (prev - 1 + mentionSuggestions.length) % mentionSuggestions.length,
        );
        return;
      }

      if (event.key === 'Escape') {
        setMentionQuery(null);
        return;
      }

      if (
        event.key === 'Enter' &&
        !event.shiftKey &&
        !event.nativeEvent.isComposing
      ) {
        event.preventDefault();
        const person = mentionSuggestions[mentionIndex] ?? mentionSuggestions[0];
        if (person) applyMentionSuggestion(person);
        return;
      }
    }
    if (
      event.key === 'Enter' &&
      !event.shiftKey &&
      !event.nativeEvent.isComposing
    ) {
      event.preventDefault();
      void handleSubmit();
    }
  };

  if (!isOpen) return null;

  return createPortal(
    <div
      className="comments-sheet-overlay fixed inset-0 z-[2000] flex items-end justify-center"
      dir="rtl"
      role="dialog"
      aria-modal="true"
      aria-label="التعليقات"
    >
      <div className="absolute inset-0" onClick={onClose} />

      <section
        aria-label="التعليقات"
        className="comments-sheet-panel relative z-10 flex w-full flex-col text-white"
        style={{
          transform: dragOffset > 0 ? `translate3d(0, ${dragOffset}px, 0)` : undefined,
          transition: dragging ? 'none' : undefined,
        }}
      >
        <div
          className="comments-sheet-handle-area"
          onClickCapture={onHandleClickCapture}
          onPointerDown={event => {
            event.stopPropagation();
            onHandlePointerDown(event);
          }}
          onTouchStart={event => {
            event.stopPropagation();
            onHandleTouchStart(event);
          }}
          onTouchMove={event => {
            event.stopPropagation();
            onHandleTouchMove(event);
          }}
          onTouchEnd={event => {
            event.stopPropagation();
            onHandleTouchEnd(event);
          }}
          onTouchCancel={event => {
            event.stopPropagation();
            onHandleTouchCancel();
          }}
        >
          <span className="comments-sheet-handle" aria-hidden="true" />
        </div>

        <header className="comments-sheet-header flex shrink-0 items-center justify-between px-4 py-3">
          <button
            type="button"
            onClick={onClose}
            className="rounded-full p-1.5 text-zinc-400 transition hover:bg-zinc-800 hover:text-white"
            aria-label="إغلاق التعليقات"
          >
            <X size={20} />
          </button>

          <div className="flex items-center gap-2" aria-live="polite">
            <MessageCircle size={18} className="text-pink-500" />
            <span className="text-base font-bold text-zinc-100">
              {formatCommentsTitle(totalComments)}
            </span>
          </div>

          <div className="w-8" />
        </header>

        {commentAccess.checking ? (
          <div className="flex flex-1 items-center justify-center text-xs text-zinc-400">جارٍ التحقق من خصوصية التعليقات…</div>
        ) : commentAccess.canRead ? (
          <CommentsList
            comments={visibleComments}
            currentUserId={currentUserId}
            postOwnerId={postOwnerId}
            restrictedUserIds={restrictedUserIds}
            pendingDeleteIds={pendingDeleteIds}
            pendingEditIds={pendingEditIds}
            pendingActionIds={pendingActionIds}
            storyOwners={storyOwners}
            highlightCommentId={initialCommentId}
            loading={loading}
            error={commentsError}
            onRetry={() => void loadComments(true)}
            onReply={item => {
              if (!commentAccess.canComment) return;
              setReplyingTo(item);
              setShowStickerPicker(false);
              window.setTimeout(() => textareaRef.current?.focus(), 0);
            }}
            onToggleLike={handleToggleLike}
            onToggleDislike={handleToggleDislike}
            onEdit={handleEditComment}
            onDelete={handleDeleteComment}
            onCopy={handleCopyComment}
            onReport={handleReportComment}
            onHide={handleHideComment}
            onTogglePin={handleTogglePin}
            onBlock={handleBlockCommentAuthor}
            onToggleRestriction={handleToggleRestriction}
          />
        ) : (
          <div className="flex flex-1 items-center justify-center px-8 text-center text-xs leading-6 text-zinc-400">
            {commentAccess.failed ? 'تعذر التحقق من صلاحية عرض التعليقات.' : 'أخفى صاحب المنشور التعليقات عن الآخرين.'}
          </div>
        )}

        {!commentAccess.checking && commentAccess.canComment ? (
          <CommentComposer
            content={content}
            replyingTo={replyingTo}
            currentUser={currentUser}
            selectedImage={selectedImage}
            previewUrl={previewUrl}
            submitting={submitting}
            showStickerPicker={showStickerPicker}
            mentionQuery={mentionQuery}
            mentionSuggestions={mentionSuggestions}
            mentionIndex={mentionIndex}
            textareaRef={textareaRef}
            onSubmit={event => {
              event.preventDefault();
              void handleSubmit();
            }}
            onContentChange={handleComposerChange}
            onKeyDown={handleComposerKeyDown}
            onCancelReply={() => setReplyingTo(null)}
            onRemoveImage={() => setSelectedImage(null)}
            onMentionSelect={applyMentionSuggestion}
            onInsertMention={insertMention}
            onToggleStickerPicker={() => setShowStickerPicker(visible => !visible)}
            onInsertSticker={insertSticker}
            onSelectImage={file => setSelectedImage(file)}
          />
        ) : !commentAccess.checking ? (
          <div className="border-t border-zinc-800 px-4 py-4 text-center text-[11px] text-zinc-500">
            {commentAccess.failed ? 'تعذر التحقق من صلاحية التعليق.' : commentAccess.canRead ? 'التعليق على هذا المنشور متاح لجمهور محدد فقط.' : 'لا يمكن إضافة تعليقات لأن التعليقات مخفية.'}
          </div>
        ) : null}
      </section>
    </div>,
    document.body,
  );
};

export default CommentsDrawer;
