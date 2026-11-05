import { useCallback, useEffect, useRef, useState } from "react";
import type { Post, Profile } from "../types";
import { buildCommentTree } from "../comments/tree";
import { handleAppError } from "../appErrors";
import { storageBucket, supabase, supabaseConfigured } from "../supabase";
import {
  attachCommentAuthors,
  fetchCommentProfiles,
  normalizeComment,
} from "./hydration";
import {
  isPending,
  markPending,
  patchCache,
} from "./store";
import type {
  CommentWithDetails,
  PostCommentRow,
  PostComments,
  RawRow,
  UploadedCommentImage,
} from "./types";
import { createComment, deleteComment } from "./commentWrites";
import {
  isMissingOptionalModerationRelation,
  isOptionalModerationRelationUnavailable,
  markOptionalModerationRelationUnavailable,
  readLocalCommentHideIds,
  writeLocalCommentHideIds,
} from "../comments/localModeration";

const COMMENT_SELECT =
  "id, post_id, user_id, parent_id, content, image_url, created_at";

export async function fetchCommentsWithReplies(
  postId: string,
  currentUserId?: string,
): Promise<CommentWithDetails[]> {
  if (!postId) return [];

  if (!supabaseConfigured) {
    throw new Error("الاتصال بقاعدة البيانات غير متاح");
  }

  const { data: comments, error } = await supabase
    .from("comments")
    .select("*")
    .eq("post_id", postId)
    .order("created_at", { ascending: true });

  if (error) {
    console.error("[comments] فشل جلب التعليقات:", error);
    throw error;
  }

  if (!comments) {
    throw new Error("تعذر قراءة التعليقات");
  }

  const rawComments = comments as RawRow[];
  if (rawComments.length === 0) return [];

  const userIds = rawComments
    .map((comment) => String(comment.user_id ?? ""))
    .filter(Boolean);

  const profilesById = await fetchCommentProfiles(userIds);
  const commentIds = rawComments
    .map((comment) => String(comment.id ?? ""))
    .filter(Boolean);

  let likes: { comment_id: string; user_id: string }[] = [];
  let dislikes: { comment_id: string; user_id: string }[] = [];

  if (commentIds.length > 0) {
    const [likesResult, dislikesResult] = await Promise.allSettled([
      supabase
        .from("comment_likes")
        .select("comment_id, user_id")
        .in("comment_id", commentIds),
      supabase
        .from("comment_dislikes")
        .select("comment_id, user_id")
        .in("comment_id", commentIds),
    ]);

    if (likesResult.status === "fulfilled" && !likesResult.value.error) {
      likes = (likesResult.value.data ?? []) as typeof likes;
    }

    if (
      dislikesResult.status === "fulfilled" &&
      !dislikesResult.value.error
    ) {
      dislikes = (dislikesResult.value.data ?? []) as typeof dislikes;
    }
  }

  const hiddenCommentIds = readLocalCommentHideIds(currentUserId ?? "");
  if (
    currentUserId &&
    commentIds.length > 0 &&
    !isOptionalModerationRelationUnavailable("comment_hides")
  ) {
    try {
      const { data: hiddenRows, error: hiddenError } = await supabase
        .from("comment_hides")
        .select("comment_id")
        .eq("user_id", currentUserId)
        .in("comment_id", commentIds);

      if (hiddenError) {
        if (isMissingOptionalModerationRelation("comment_hides", hiddenError)) {
          markOptionalModerationRelationUnavailable("comment_hides");
        } else {
          throw hiddenError;
        }
      } else {
        (hiddenRows ?? []).forEach((row: { comment_id: string }) => {
          hiddenCommentIds.add(String(row.comment_id));
        });
        writeLocalCommentHideIds(currentUserId, hiddenCommentIds);
      }
    } catch (hiddenError) {
      if (isMissingOptionalModerationRelation("comment_hides", hiddenError)) {
        markOptionalModerationRelationUnavailable("comment_hides");
      } else {
        throw hiddenError;
      }
    }
  }

  const likesMap = new Map<string, { count: number; isLiked: boolean }>();
  likes.forEach((like) => {
    const current = likesMap.get(like.comment_id) ?? {
      count: 0,
      isLiked: false,
    };

    likesMap.set(like.comment_id, {
      count: current.count + 1,
      isLiked:
        current.isLiked ||
        (!!currentUserId && like.user_id === currentUserId),
    });
  });

  const dislikesMap = new Map<
    string,
    { count: number; isDisliked: boolean }
  >();
  dislikes.forEach((dislike) => {
    const current = dislikesMap.get(dislike.comment_id) ?? {
      count: 0,
      isDisliked: false,
    };

    dislikesMap.set(dislike.comment_id, {
      count: current.count + 1,
      isDisliked:
        current.isDisliked ||
        (!!currentUserId && dislike.user_id === currentUserId),
    });
  });

  const formatted: CommentWithDetails[] = rawComments.map((comment) => {
    const commentId = String(comment.id);
    const author = profilesById.get(String(comment.user_id ?? ""));

    return {
      id: commentId,
      post_id: String(comment.post_id ?? ""),
      user_id: String(comment.user_id ?? ""),
      parent_id: comment.parent_id ? String(comment.parent_id) : null,
      content: String(comment.content ?? ""),
      image_url: comment.image_url ? String(comment.image_url) : null,
      created_at: String(comment.created_at ?? new Date().toISOString()),
      profiles: author
        ? {
            full_name: String(author.full_name ?? author.display_name ?? ""),
            username: String(author.username ?? ""),
            avatar_url: author.avatar_url
              ? String(author.avatar_url)
              : null,
          }
        : null,
      likes_count: likesMap.get(commentId)?.count ?? 0,
      is_liked: likesMap.get(commentId)?.isLiked ?? false,
      dislikes_count: dislikesMap.get(commentId)?.count ?? 0,
      is_disliked: dislikesMap.get(commentId)?.isDisliked ?? false,
      is_pinned: Boolean(comment.is_pinned),
      is_hidden_by_me: hiddenCommentIds.has(commentId),
      replies: [],
    };
  });

  return buildCommentTree(formatted);
}

export async function toggleCommentLike(
  commentId: string,
  userId: string,
  isLiked: boolean,
): Promise<void> {
  if (!supabaseConfigured || !userId) {
    throw new Error("الاتصال بقاعدة البيانات غير متاح");
  }

  if (isLiked) {
    const { error } = await supabase
      .from("comment_likes")
      .delete()
      .eq("comment_id", commentId)
      .eq("user_id", userId);

    if (error) throw error;
  } else {
    const { error: oppositeError } = await supabase
      .from("comment_dislikes")
      .delete()
      .eq("comment_id", commentId)
      .eq("user_id", userId);

    if (oppositeError) throw oppositeError;

    const { error } = await supabase
      .from("comment_likes")
      .upsert(
        { comment_id: commentId, user_id: userId },
        {
          onConflict: "comment_id,user_id",
          ignoreDuplicates: true,
        },
      );

    if (error) throw error;
  }
}

export async function toggleCommentDislike(
  commentId: string,
  userId: string,
  isDisliked: boolean,
): Promise<void> {
  if (!supabaseConfigured || !userId) {
    throw new Error("الاتصال بقاعدة البيانات غير متاح");
  }

  if (isDisliked) {
    const { error } = await supabase
      .from("comment_dislikes")
      .delete()
      .eq("comment_id", commentId)
      .eq("user_id", userId);

    if (error) throw error;
  } else {
    const { error: oppositeError } = await supabase
      .from("comment_likes")
      .delete()
      .eq("comment_id", commentId)
      .eq("user_id", userId);

    if (oppositeError) throw oppositeError;

    const { error } = await supabase
      .from("comment_dislikes")
      .upsert(
        { comment_id: commentId, user_id: userId },
        { onConflict: "comment_id,user_id", ignoreDuplicates: true },
      );

    if (error) throw error;
  }
}

export async function uploadCommentImage(
  file: File,
  userId: string,
): Promise<UploadedCommentImage> {
  if (!supabaseConfigured || !userId) {
    throw new Error("الاتصال بقاعدة البيانات غير متاح");
  }

  if (!file.type.startsWith("image/")) {
    throw new Error("اختر ملف صورة صالحًا");
  }

  if (file.size > 10 * 1024 * 1024) {
    throw new Error("حجم الصورة يجب ألا يتجاوز 10 ميغابايت");
  }

  const extension = file.name.match(/\.([a-z0-9]{1,8})$/i)?.[1] ?? "jpg";
  const path = `${userId}/comments/${crypto.randomUUID()}.${extension.toLowerCase()}`;

  const { error } = await supabase.storage
    .from(storageBucket)
    .upload(path, file, { contentType: file.type, upsert: false });

  if (error) throw error;

  const { data } = supabase.storage.from(storageBucket).getPublicUrl(path);
  return { publicUrl: data.publicUrl, path };
}

export async function translateText(
  text: string,
  targetLang = "ar",
): Promise<string> {
  try {
    const res = await fetch(
      `https://api.mymemory.translated.net/get?q=${encodeURIComponent(text)}&langpair=Autodetect|${targetLang}`,
    );

    const data = await res.json();
    return data.responseData?.translatedText || text;
  } catch {
    return text;
  }
}

export function usePostComments(
  post: Post,
  userId: string,
  profile: Profile | null,
  enabled: boolean,
): PostComments {
  const [comments, setComments] = useState<PostCommentRow[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const loadedRef = useRef(false);

  const load = useCallback(async () => {
    if (!supabaseConfigured) {
      setComments(null);
      setError("الاتصال بقاعدة البيانات غير متاح");
      setLoading(false);
      return;
    }

    setLoading(true);
    setError(null);

    try {
      const { data, error: loadError } = await supabase
        .from("comments")
        .select(COMMENT_SELECT)
        .eq("post_id", post.id)
        .order("created_at", { ascending: true });

      if (loadError) {
        console.error("[comments] فشل تحميل التعليقات:", loadError);
        setError("تعذر تحميل التعليقات");
        return;
      }

      const rows = await attachCommentAuthors((data ?? []) as RawRow[]);
      setComments(rows);

      if (!isPending(post.id, userId)) {
        patchCache(post.id, userId, {
          comments: rows.length,
          hydrated: true,
        });
      }
    } catch (loadError) {
      console.error("[comments] خطأ أثناء تحميل التعليقات:", loadError);
      setError("تعذر تحميل التعليقات");
    } finally {
      setLoading(false);
    }
  }, [post.id, userId, profile]);

  useEffect(() => {
    if (!enabled || loadedRef.current) return;

    loadedRef.current = true;
    void load();
  }, [enabled, load]);

  useEffect(() => {
    loadedRef.current = false;
    setComments(null);
    setError(null);
  }, [post.id]);

  useEffect(() => {
    if (!enabled || !supabaseConfigured) return;

    const channel = supabase
      .channel(`aani-comments-${post.id}`)
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "comments",
          filter: `post_id=eq.${post.id}`,
        },
        (payload) => {
          const record = (payload.new ?? payload.old ?? {}) as RawRow;
          const id = record.id ? String(record.id) : "";

          if (!id) return;

          if (payload.eventType === "DELETE") {
            setComments((previous) =>
              previous
                ? previous.filter((item) => item.id !== id)
                : previous,
            );
            return;
          }

          if (payload.eventType === "INSERT") {
            setComments((previous) => {
              if (!previous || previous.some((item) => item.id === id)) {
                return previous;
              }

              return [
                ...previous,
                { ...normalizeComment(record), author: null },
              ];
            });

            void supabase
              .from("comments")
              .select(COMMENT_SELECT)
              .eq("id", id)
              .maybeSingle()
              .then(async ({ data, error: fetchError }) => {
                if (fetchError) {
                  console.warn(
                    "[comments] تعذر تحديث بيانات التعليق الجديد:",
                    fetchError,
                  );
                  return;
                }

                if (!data) return;

                const [withAuthor] = await attachCommentAuthors([
                  data as RawRow,
                ]);

                if (!withAuthor) return;

                setComments((previous) =>
                  previous
                    ? previous.map((item) =>
                        item.id === id ? withAuthor : item,
                      )
                    : previous,
                );
              });
          }
        },
      )
      .subscribe((status) => {
        if (status === "CHANNEL_ERROR" || status === "TIMED_OUT") {
          handleAppError(
            'فشل تحديث التعليقات مباشرة',
            new Error(`Comments realtime channel ${status}`),
            'تعذر تحديث التعليقات مباشرة. تحقق من الاتصال.',
          );
        }
      });

    return () => {
      void supabase.removeChannel(channel);
    };
  }, [enabled, post.id]);

  const add = useCallback(
    async (content: string) => {
      const trimmed = content.trim();
      if (!trimmed) return false;

      setSending(true);

      try {
        const row = await createComment(post, userId, trimmed);
        if (!row) return false;

        setComments((previous) => {
          const list = previous ?? [];

          return list.some((item) => item.id === row.id)
            ? list
            : [...list, { ...row, author: profile }];
        });

        return true;
      } finally {
        setSending(false);
      }
    },
    [post, profile, userId],
  );

  const remove = useCallback(
    async (commentId: string) => {
      const ok = await deleteComment(post, userId, commentId);
      if (ok) await load();
    },
    [load, post, userId],
  );

  return { comments, loading, sending, error, load, add, remove };
}
