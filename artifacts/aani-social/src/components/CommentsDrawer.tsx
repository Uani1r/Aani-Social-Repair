import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AtSign,
  Image,
  MessageCircle,
  Send,
  Sticker,
  X,
} from 'lucide-react';
import { toast } from 'sonner';

import CommentItem from './CommentItem';
import {
  fetchCommentsWithReplies,
  syncCommentCount,
  toggleCommentDislike,
  toggleCommentLike,
  uploadCommentImage,
  type CommentWithDetails,
} from '../lib/interactions';
import { supabase, storageBucket } from '../lib/supabase';

interface CommentsDrawerProps {
  postId: string;
  currentUserId: string;
  isOpen: boolean;
  onClose: () => void;
  initialCommentsCount?: number;
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

const formatCounter = (value: number): string => {
  if (value === 0) return '0';

  return value > 999
    ? `${(value / 1000).toFixed(1).replace(/\.0$/, '')}K`
    : String(value);
};

const countComments = (items: CommentWithDetails[]): number =>
  items.reduce(
    (count, item) => count + 1 + countComments(item.replies ?? []),
    0,
  );

const insertCommentIntoTree = (
  items: CommentWithDetails[],
  optimistic: CommentWithDetails,
): CommentWithDetails[] => {
  if (!optimistic.parent_id) return [...items, optimistic];

  return items.map((item) =>
    item.id === optimistic.parent_id
      ? {
          ...item,
          replies: [...(item.replies ?? []), optimistic],
        }
      : {
          ...item,
          replies: item.replies
            ? insertCommentIntoTree(item.replies, optimistic)
            : item.replies,
        },
  );
};

const replaceCommentInTree = (
  items: CommentWithDetails[],
  targetId: string,
  next: CommentWithDetails,
): CommentWithDetails[] =>
  items.map((item) =>
    item.id === targetId
      ? next
      : item.replies
        ? {
            ...item,
            replies: replaceCommentInTree(item.replies, targetId, next),
          }
        : item,
  );

const removeCommentFromTree = (
  items: CommentWithDetails[],
  targetId: string,
): CommentWithDetails[] =>
  items
    .filter((item) => item.id !== targetId)
    .map((item) =>
      item.replies
        ? { ...item, replies: removeCommentFromTree(item.replies, targetId) }
        : item,
    );

const patchCommentInTree = (
  items: CommentWithDetails[],
  targetId: string,
  patch: Partial<CommentWithDetails>,
): CommentWithDetails[] =>
  items.map((item) =>
    item.id === targetId
      ? { ...item, ...patch }
      : item.replies
        ? {
            ...item,
            replies: patchCommentInTree(item.replies, targetId, patch),
          }
        : item,
  );

const findCommentById = (
  items: CommentWithDetails[],
  targetId: string,
): CommentWithDetails | null => {
  for (const item of items) {
    if (item.id === targetId) return item;

    const inReplies = findCommentById(item.replies ?? [], targetId);
    if (inReplies) return inReplies;
  }

  return null;
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
  likes_count: 0,
  dislikes_count: 0,
  is_liked: false,
  is_disliked: false,
  replies: [],
});

const buildInitials = (fullName?: string | null): string => {
  const source = (fullName ?? '').trim();

  if (!source) return 'آ';

  const initials = source
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? '')
    .join('')
    .slice(0, 2);

  return initials || 'آ';
};

export const CommentsDrawer: React.FC<CommentsDrawerProps> = ({
  postId,
  currentUserId,
  isOpen,
  onClose,
  initialCommentsCount = 0,
}) => {
  const [comments, setComments] = useState<CommentWithDetails[]>([]);
  const [content, setContent] = useState('');
  const [replyingTo, setReplyingTo] = useState<CommentWithDetails | null>(null);
  const [selectedImage, setSelectedImage] = useState<File | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [commentsError, setCommentsError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [pendingReactionIds, setPendingReactionIds] = useState<
    Record<string, boolean>
  >({});
  const [pendingDeleteIds, setPendingDeleteIds] = useState<
    Record<string, boolean>
  >({});
  const [showStickerPicker, setShowStickerPicker] = useState(false);

  const commentIdsRef = useRef<Set<string>>(new Set());

  const [currentUser, setCurrentUser] = useState<{
    full_name: string;
    username: string;
    avatar_url: string | null;
  } | null>(null);

  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const imageInputRef = useRef<HTMLInputElement | null>(null);

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

    void loadComments(initialCommentsCount > 0);

    return () => {
      cancelled = true;
    };
  }, [isOpen, postId, currentUserId, loadComments, initialCommentsCount]);

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
        if (error) {
          console.error(
            'Comments realtime subscription error:',
            getErrorDetails(error),
          );
        }

        if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
          console.error('Comments realtime channel status:', status);
        }
      });

    return () => {
      void supabase.removeChannel(channel);
    };
  }, [isOpen, postId, loadComments]);

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
    const activeTreeCount = countComments(comments);
    if (activeTreeCount > 0) return activeTreeCount;
    return initialCommentsCount;
  }, [comments, initialCommentsCount]);

  const insertMention = () => {
    if (replyingTo) {
      const mention = `@${replyingTo.profiles?.username || 'user'} `;

      setContent((prev) => `${prev}${prev.trim() ? ' ' : ''}${mention}`);
    } else {
      setContent((prev) => `${prev}${prev.trim() ? ' ' : ''}@`);
    }

    window.setTimeout(() => textareaRef.current?.focus(), 0);
  };

  const insertSticker = (sticker: string) => {
    setContent(
      (prev) => `${prev}${prev && !prev.endsWith(' ') ? ' ' : ''}${sticker}`,
    );

    setShowStickerPicker(false);
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
      replies: [],
    };

    const optimisticList = insertCommentIntoTree(comments, optimisticComment);
    setComments(optimisticList);
    syncCommentCount(postId, currentUserId, countComments(optimisticList));

    setContent('');
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

      if (replyingTo && replyingTo.user_id !== currentUserId) {
        void supabase
          .from('notifications')
          .insert({
            user_id: replyingTo.user_id,
            actor_id: currentUserId,
            type: 'reply',
            comment_id: replyingTo.id,
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

  const handleDeleteComment = async (comment: CommentWithDetails) => {
    if (
      comment.user_id !== currentUserId ||
      pendingDeleteIds[comment.id] ||
      !window.confirm('هل تريد حذف هذا التعليق؟')
    ) {
      return;
    }

    setPendingDeleteIds((prev) => ({
      ...prev,
      [comment.id]: true,
    }));

    try {
      const { data, error } = await supabase
        .from('comments')
        .delete()
        .eq('id', comment.id)
        .eq('user_id', currentUserId)
        .select('id')
        .maybeSingle();

      if (error) throw error;

      if (!data?.id) {
        toast.error('لم يُحذف التعليق؛ تحقق من صلاحيات الحساب');
        return;
      }

      toast.success('تم حذف التعليق');
      await loadComments(false);
    } catch (error: unknown) {
      toast.error('تعذر حذف التعليق');
    } finally {
      setPendingDeleteIds((prev) => {
        const next = { ...prev };
        delete next[comment.id];
        return next;
      });
    }
  };

  const handleComposerKeyDown = (
    event: React.KeyboardEvent<HTMLTextAreaElement>,
  ) => {
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

  return (
    <div
      className="fixed inset-0 z-[100] flex items-end justify-center bg-black/60 backdrop-blur-sm"
      dir="rtl"
    >
      <div className="absolute inset-0" onClick={onClose} />

      <section
        aria-label="التعليقات"
        className="relative z-10 flex w-full max-w-2xl flex-col rounded-t-[28px] border border-b-0 border-zinc-800 bg-zinc-950 text-white shadow-2xl sm:rounded-t-3xl"
        style={{
          height: 'min(88dvh, calc(100dvh - env(safe-area-inset-top)))',
        }}
      >
        <header className="flex shrink-0 items-center justify-between border-b border-zinc-800/80 px-4 py-3">
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
              التعليقات · {formatCounter(totalComments)}
            </span>
          </div>

          <div className="w-8" />
        </header>

        <div className="flex-1 space-y-0 overflow-y-auto overscroll-contain px-4 py-1">
          {commentsError && (
            <div
              className="my-3 flex items-center justify-between gap-3 rounded-xl border border-red-900/70 bg-red-950/40 px-3 py-2 text-sm text-red-200"
              role="alert"
            >
              <span>{commentsError}</span>
              <button
                type="button"
                onClick={() => void loadComments(true)}
                className="shrink-0 rounded-full px-3 py-1 text-xs font-semibold hover:bg-red-900/50"
              >
                إعادة المحاولة
              </button>
            </div>
          )}

          {loading && comments.length === 0 && !commentsError ? (
            <div
              className="flex h-40 items-center justify-center text-sm text-zinc-500"
              role="status"
            >
              جاري تحميل التعليقات...
            </div>
          ) : !loading && !commentsError && comments.length === 0 ? (
            <div className="flex h-40 flex-col items-center justify-center gap-2 text-center text-zinc-500">
              <MessageCircle size={32} className="text-zinc-700" />
              <p className="text-sm">
                لا توجد تعليقات بعد... كن أول من يعلق!
              </p>
            </div>
          ) : comments.length > 0 ? (
            comments.map((comment) => (
              <CommentItem
                key={comment.id}
                comment={comment}
                currentUserId={currentUserId}
                pendingReactionIds={pendingReactionIds}
                pendingDeleteIds={pendingDeleteIds}
                onReply={(item) => {
                  setReplyingTo(item);
                  setShowStickerPicker(false);
                  window.setTimeout(() => textareaRef.current?.focus(), 0);
                }}
                onToggleLike={handleToggleLike}
                onToggleDislike={handleToggleDislike}
                onDelete={handleDeleteComment}
              />
            ))
          ) : null}
        </div>

        <footer
          className="shrink-0 space-y-2 border-t border-zinc-800/90 bg-zinc-950 px-3 pt-3 sm:px-4"
          style={{
            paddingBottom: 'max(0.75rem, env(safe-area-inset-bottom))',
          }}
        >
          {replyingTo && (
            <div className="flex items-center justify-between rounded-xl border border-zinc-800 bg-zinc-900 px-3 py-1.5 text-xs text-zinc-300">
              <span>
                الرد على{' '}
                <strong className="text-pink-400">
                  @{replyingTo.profiles?.username || 'مستخدم'}
                </strong>
              </span>

              <button
                type="button"
                onClick={() => setReplyingTo(null)}
                className="text-zinc-400 hover:text-white"
                aria-label="إلغاء الرد"
              >
                <X size={14} />
              </button>
            </div>
          )}

          {previewUrl && (
            <div className="relative mr-1 inline-block h-16 w-16 overflow-hidden rounded-xl border border-zinc-700">
              <img
                src={previewUrl}
                alt="معاينة الصورة المرفقة"
                className="h-full w-full object-cover"
              />

              <button
                type="button"
                onClick={() => setSelectedImage(null)}
                className="absolute left-1 top-1 rounded-full bg-black/80 p-1 text-white hover:bg-black"
                aria-label="إزالة الصورة"
              >
                <X size={12} />
              </button>
            </div>
          )}

          <form
            className="flex items-center gap-2.5"
            onSubmit={(event) => {
              event.preventDefault();
              void handleSubmit();
            }}
          >
            <div className="shrink-0">
              {currentUser?.avatar_url ? (
                <img
                  src={currentUser.avatar_url}
                  alt={currentUser.full_name}
                  className="h-11 w-11 rounded-full object-cover ring-1 ring-zinc-700"
                />
              ) : (
                <div className="flex h-11 w-11 items-center justify-center rounded-full bg-gradient-to-br from-pink-500 to-violet-600 text-sm font-bold text-white ring-1 ring-zinc-700">
                  {buildInitials(currentUser?.full_name)}
                </div>
              )}
            </div>

            <div className="relative flex min-w-0 flex-1 items-center rounded-full border border-zinc-700/70 bg-zinc-800/90 px-3 py-2.5 transition focus-within:border-pink-500/50">
              {showStickerPicker && (
                <div
                  className="absolute bottom-full left-0 z-20 mb-3 grid grid-cols-5 gap-1 rounded-2xl border border-zinc-700 bg-zinc-900 p-2 shadow-xl"
                  role="group"
                  aria-label="اختيار ملصق"
                >
                  {[
                    '❤️',
                    '🥰',
                    '😂',
                    '👏',
                    '🙏',
                    '✨',
                    '🌷',
                    '🤍',
                    '🫶',
                    '🎉',
                  ].map((sticker) => (
                    <button
                      key={sticker}
                      type="button"
                      onClick={() => insertSticker(sticker)}
                      className="flex h-9 w-9 items-center justify-center rounded-lg text-xl hover:bg-zinc-800"
                      aria-label={`إضافة ${sticker}`}
                    >
                      {sticker}
                    </button>
                  ))}
                </div>
              )}

              <textarea
                ref={textareaRef}
                rows={1}
                value={content}
                onChange={(event) => setContent(event.target.value)}
                onKeyDown={handleComposerKeyDown}
                placeholder={replyingTo ? 'اكتب رداً...' : 'إضافة تعليق...'}
                maxLength={2000}
                className="max-h-32 min-h-7 flex-1 resize-none bg-transparent px-1 text-right text-sm leading-7 text-zinc-100 placeholder-zinc-400 focus:outline-none"
                dir="rtl"
                aria-label={replyingTo ? 'اكتب رداً' : 'إضافة تعليق'}
              />

              <div className="mr-1 flex shrink-0 items-center gap-2 text-zinc-300">
                <button
                  type="button"
                  onClick={insertMention}
                  className="rounded-full p-1.5 transition hover:bg-zinc-700 hover:text-white"
                  title="إشارة @"
                  aria-label="إضافة إشارة"
                >
                  <AtSign size={22} strokeWidth={2.4} />
                </button>

                <button
                  type="button"
                  onClick={() => setShowStickerPicker((visible) => !visible)}
                  className="rounded-full p-1.5 transition hover:bg-zinc-700 hover:text-white"
                  title="ملصقات"
                  aria-label="اختيار ملصق"
                  aria-expanded={showStickerPicker}
                >
                  <Sticker size={22} strokeWidth={2.3} />
                </button>

                <button
                  type="button"
                  onClick={() => imageInputRef.current?.click()}
                  className="rounded-full p-1.5 transition hover:bg-zinc-700 hover:text-white"
                  title="إرفاق صورة"
                  aria-label="إرفاق صورة"
                >
                  <Image size={22} strokeWidth={2.3} />
                </button>

                {(content.trim() || selectedImage) && (
                  <button
                    type="submit"
                    disabled={submitting}
                    className="rounded-full bg-pink-600 p-2 text-white transition hover:bg-pink-500 disabled:cursor-wait disabled:opacity-50"
                    aria-label="نشر التعليق"
                  >
                    <Send size={18} className="rotate-180" />
                  </button>
                )}
              </div>
            </div>

            <input
              ref={imageInputRef}
              type="file"
              accept="image/*"
              className="sr-only"
              onChange={(event) => {
                const file = event.currentTarget.files?.[0] ?? null;
                event.currentTarget.value = '';

                if (!file) return;

                if (file.size > 10 * 1024 * 1024) {
                  toast.error('حجم الصورة يجب ألا يتجاوز 10 ميغابايت');
                  return;
                }

                setSelectedImage(file);
              }}
            />
          </form>
        </footer>
      </section>
    </div>
  );
};

export default CommentsDrawer;
