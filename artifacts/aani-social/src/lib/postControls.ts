/**
 * Post-level controls that live on top of the core interaction layer:
 *
 *  - "مهتم / غير مهتم" feedback (per viewer, per post) -> `post_feedback`
 *  - closing / reopening the comment thread           -> `posts.comments_disabled`
 *  - an attached music / audio track                  -> `posts.audio_url` + `posts.audio_title`
 *
 * The live database may not have been migrated yet (the columns/table are added
 * by `supabase/migrations/20261028000000_post_controls.sql`). Every write here
 * therefore tries the database first and, when the column/table is missing,
 * falls back to a local store so the button still does something real and the
 * UI never lies about what was saved.
 */

import { useCallback, useSyncExternalStore } from "react";
import { toast } from "sonner";

import { supabase, supabaseConfigured } from "./supabase";
import { uploadMedia } from "./storyUpload";
import { extractAudio, MAX_UPLOAD_BYTES } from "../utils/mediaCompressor";
import type { Post, PostFeedback } from "./types";

/* ------------------------------------------------------------------ */
/* Types                                                               */
/* ------------------------------------------------------------------ */

export type PostAudio = { url: string; title: string };

export type PostControlState = {
  feedback: PostFeedback | null;
  commentsDisabled: boolean;
  audio: PostAudio | null;
};

/** Tells the owner-facing UI that a write was only kept locally. */
export const MIGRATION_HINT =
  "تم الحفظ على هذا الجهاز فقط. طبّق ملف الترحيل supabase/migrations/20261028000000_post_controls.sql لتفعيل الحفظ في قاعدة البيانات.";

/* ------------------------------------------------------------------ */
/* Missing-column / missing-table detection                            */
/* ------------------------------------------------------------------ */

function errorMeta(error: unknown): { code: string; message: string } {
  if (!error || typeof error !== "object") return { code: "", message: "" };
  const candidate = error as { code?: string; message?: string; details?: string };
  return {
    code: candidate.code ?? "",
    message: `${candidate.message ?? ""} ${candidate.details ?? ""}`.trim(),
  };
}

/** True when the write failed only because the schema has not been migrated. */
export function isSchemaGap(error: unknown): boolean {
  const { code, message } = errorMeta(error);
  return (
    code === "42P01" || // undefined_table
    code === "42703" || // undefined_column
    code === "PGRST204" || // column not in schema cache
    code === "PGRST205" || // table not in schema cache
    code === "42501" || // insufficient privilege
    /does not exist|schema cache|could not find the table|could not find the .* column|column .* does not exist/i.test(
      message,
    )
  );
}

function isDuplicate(error: unknown): boolean {
  return errorMeta(error).code === "23505";
}

/* ------------------------------------------------------------------ */
/* Shared store                                                        */
/* ------------------------------------------------------------------ */

const stateKey = (postId: string, userId: string) => `${userId || "anon"}:${postId}`;

const interactionCache = new Map<string, PostFeedback | null>();
const postCache = new Map<string, { commentsDisabled: boolean; audio: PostAudio | null }>();
const listeners = new Set<() => void>();
const pendingKeys = new Set<string>();
let version = 0;

function emit(): void {
  version += 1;
  listeners.forEach((listener) => listener());
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/* ------------------------------------------------------------------ */
/* Local fallback                                                      */
/* ------------------------------------------------------------------ */

const FEEDBACK_KEY = "aani:post-feedback:v1";
const POST_CONTROLS_KEY = "aani:post-controls:v1";

type FeedbackMap = Record<string, Record<string, PostFeedback>>;
type ControlsMap = Record<string, { commentsDisabled?: boolean; audio?: PostAudio | null }>;

function readJson<T>(key: string, fallback: T): T {
  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) return fallback;
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === "object" ? (parsed as T) : fallback;
  } catch {
    return fallback;
  }
}

function writeJson(key: string, value: unknown): void {
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* private mode / quota - the in-memory cache still works this session */
  }
}

function readLocalFeedback(userId: string): Record<string, PostFeedback> {
  if (!userId) return {};
  const all = readJson<FeedbackMap>(FEEDBACK_KEY, {});
  return all[userId] ?? {};
}

function writeLocalFeedback(userId: string, postId: string, value: PostFeedback | null): void {
  if (!userId) return;
  const all = readJson<FeedbackMap>(FEEDBACK_KEY, {});
  const mine = { ...(all[userId] ?? {}) };
  if (value) mine[postId] = value;
  else delete mine[postId];
  all[userId] = mine;
  writeJson(FEEDBACK_KEY, all);
}

function readLocalControls(postId: string) {
  const all = readJson<ControlsMap>(POST_CONTROLS_KEY, {});
  return all[postId] ?? {};
}

function writeLocalControls(postId: string, patch: { commentsDisabled?: boolean; audio?: PostAudio | null }) {
  const all = readJson<ControlsMap>(POST_CONTROLS_KEY, {});
  all[postId] = { ...(all[postId] ?? {}), ...patch };
  writeJson(POST_CONTROLS_KEY, all);
}

/* ------------------------------------------------------------------ */
/* Read helpers                                                        */
/* ------------------------------------------------------------------ */

export function readPostFeedback(postId: string, userId: string): PostFeedback | null {
  const key = stateKey(postId, userId);
  if (interactionCache.has(key)) return interactionCache.get(key) ?? null;
  const local = readLocalFeedback(userId)[postId] ?? null;
  return local;
}

export function readCommentsDisabled(postId: string, fromRow?: boolean): boolean {
  const cached = postCache.get(postId);
  if (cached) return cached.commentsDisabled;
  if (typeof fromRow === "boolean") return fromRow;
  const local = readLocalControls(postId);
  return Boolean(local.commentsDisabled);
}

export function readPostAudio(postId: string, fromRow?: PostAudio | null): PostAudio | null {
  const cached = postCache.get(postId);
  if (cached && cached.audio) {
    // A removed track is stored as an explicit null marker.
    return cached.audio;
  }
  if (fromRow?.url) return fromRow;
  const local = readLocalControls(postId);
  if (local.audio === null) return null;
  return local.audio ?? fromRow ?? null;
}

/**
 * Posts the viewer marked as "غير مهتم" are removed from their own feed.
 * Returns the ids so a feed hook can filter without re-reading storage per card.
 */
export function hiddenPostIds(userId: string): Set<string> {
  if (!userId) return new Set();
  const local = readLocalFeedback(userId);
  const hidden = new Set<string>();
  for (const [postId, value] of Object.entries(local)) {
    if (value === "not_interested") hidden.add(postId);
  }
  for (const [key, value] of interactionCache.entries()) {
    if (!key.startsWith(`${userId}:`)) continue;
    const postId = key.slice(userId.length + 1);
    if (value === "not_interested") hidden.add(postId);
    else if (value === "interested") hidden.delete(postId);
  }
  return hidden;
}

/** Hydrates feedback for many posts in one query (used by the feed). */
export async function hydrateFeedback(postIds: string[], userId: string): Promise<void> {
  if (!supabaseConfigured || !userId || postIds.length === 0) return;
  try {
    const { data, error } = await supabase
      .from("post_feedback")
      .select("post_id, feedback")
      .eq("user_id", userId)
      .in("post_id", postIds);
    if (error) return; // table may not be migrated yet - local store stays authoritative
    (data ?? []).forEach((row) => {
      const postId = String((row as { post_id?: string }).post_id ?? "");
      const value = (row as { feedback?: string }).feedback;
      if (!postId) return;
      interactionCache.set(
        stateKey(postId, userId),
        value === "interested" || value === "not_interested" ? value : null,
      );
    });
    emit();
  } catch {
    /* non fatal */
  }
}

/* ------------------------------------------------------------------ */
/* Writes                                                              */
/* ------------------------------------------------------------------ */

export async function setPostFeedback(
  postId: string,
  userId: string,
  value: PostFeedback | null,
): Promise<{ persisted: boolean }> {
  if (!userId) return { persisted: false };
  const key = stateKey(postId, userId);
  const previous = interactionCache.has(key) ? interactionCache.get(key) ?? null : readPostFeedback(postId, userId);

  // Optimistic: the label flips immediately.
  interactionCache.set(key, value);
  pendingKeys.add(key);
  emit();

  const rollback = () => {
    interactionCache.set(key, previous);
    pendingKeys.delete(key);
    emit();
  };

  if (!supabaseConfigured) {
    writeLocalFeedback(userId, postId, value);
    pendingKeys.delete(key);
    emit();
    return { persisted: false };
  }

  try {
    if (value === null) {
      const { error } = await supabase
        .from("post_feedback")
        .delete()
        .eq("post_id", postId)
        .eq("user_id", userId);
      if (error && !isSchemaGap(error)) throw error;
      if (error) {
        writeLocalFeedback(userId, postId, null);
        pendingKeys.delete(key);
        emit();
        return { persisted: false };
      }
    } else {
      const { error } = await supabase
        .from("post_feedback")
        .upsert(
          { post_id: postId, user_id: userId, feedback: value },
          { onConflict: "post_id,user_id" },
        );
      if (error && !isDuplicate(error) && !isSchemaGap(error)) throw error;
      if (error) {
        writeLocalFeedback(userId, postId, value);
        pendingKeys.delete(key);
        emit();
        return { persisted: false };
      }
    }

    writeLocalFeedback(userId, postId, value);
    pendingKeys.delete(key);
    emit();
    return { persisted: true };
  } catch (reason) {
    rollback();
    throw reason;
  }
}

export async function setCommentsDisabled(postId: string, disabled: boolean): Promise<{ persisted: boolean }> {
  const previous = readCommentsDisabled(postId);
  postCache.set(postId, {
    commentsDisabled: disabled,
    audio: postCache.get(postId)?.audio ?? null,
  });
  pendingKeys.add(postId);
  emit();

  const localOnly = () => {
    writeLocalControls(postId, { commentsDisabled: disabled });
    pendingKeys.delete(postId);
    emit();
    return { persisted: false };
  };

  if (!supabaseConfigured) return localOnly();

  try {
    const { error } = await supabase
      .from("posts")
      .update({ comments_disabled: disabled })
      .eq("id", postId);
    if (error) {
      if (isSchemaGap(error)) return localOnly();
      throw error;
    }
    pendingKeys.delete(postId);
    emit();
    return { persisted: true };
  } catch (reason) {
    postCache.set(postId, { commentsDisabled: previous, audio: postCache.get(postId)?.audio ?? null });
    pendingKeys.delete(postId);
    emit();
    throw reason;
  }
}

export async function setPostAudio(
  postId: string,
  audio: PostAudio | null,
): Promise<{ persisted: boolean }> {
  const previous = readPostAudio(postId);
  postCache.set(postId, { commentsDisabled: readCommentsDisabled(postId), audio });
  pendingKeys.add(postId);
  emit();

  const localOnly = () => {
    writeLocalControls(postId, { audio });
    pendingKeys.delete(postId);
    emit();
    return { persisted: false };
  };

  if (!supabaseConfigured) return localOnly();

  try {
    const { error } = await supabase
      .from("posts")
      .update({
        audio_url: audio?.url ?? null,
        audio_title: audio?.title ?? null,
        updated_at: new Date().toISOString(),
      })
      .eq("id", postId);
    if (error) {
      if (isSchemaGap(error)) return localOnly();
      throw error;
    }
    pendingKeys.delete(postId);
    emit();
    return { persisted: true };
  } catch (reason) {
    postCache.set(postId, { commentsDisabled: readCommentsDisabled(postId), audio: previous });
    pendingKeys.delete(postId);
    emit();
    throw reason;
  }
}

/** Uploads a track to ImageKit (direct browser upload) and returns its public URL. */
export async function uploadPostAudio(
  file: File,
  userId: string,
  postId: string,
): Promise<PostAudio> {
  const safeName = file.name.replace(/[^a-zA-Z0-9._-]/g, "-");
  const path = `${userId}/audio-${postId}-${Date.now()}-${safeName}`;
  // الملف الصوتي المرفوع مباشرة يُحوَّل أولاً إلى AAC/M4A (112kbps، 44.1kHz)
  // بنفس مسار الصوت المستخرج من الفيديو — لا رفع خام يستنزف حد التخزين.
  // عند فشل التحويل (متصفح قديم بلا WebCodecs) يُرفع الأصل فقط إذا كان ضمن
  // حد الحجم المعتمد MAX_UPLOAD_BYTES؛ وإلا يفشل الرفع برسالة واضحة.
  let audioFile: File = file;
  try {
    audioFile = await extractAudio(file, { kind: 'extractedSound' });
  } catch (error) {
    if (file.size > MAX_UPLOAD_BYTES) {
      throw error;
    }
    console.warn("[postControls] تعذر تحويل الصوت إلى M4A — سيُرفع الأصل ضمن حد الحجم:", error);
  }
  // الرفع مباشرة إلى ImageKit — يعيد الرابط العام النهائي ويُسجَّل في
  // سجل روابط supabase.ts فتقرأه أي getPublicUrl لاحقة بشكل صحيح
  const url = await uploadMedia({ file: audioFile, path });
  return { url, title: file.name.replace(/\.[^.]+$/, "") };
}

/* ------------------------------------------------------------------ */
/* Hook                                                                */
/* ------------------------------------------------------------------ */

export type UsePostControls = PostControlState & {
  pending: boolean;
  setFeedback: (value: PostFeedback | null) => Promise<void>;
  toggleComments: () => Promise<void>;
  changeAudio: (audio: PostAudio | null) => Promise<void>;
};

export function usePostControls(post: Post, userId: string): UsePostControls {
  const key = stateKey(post.id, userId);

  const rowAudio: PostAudio | null =
    post.audio_url ? { url: post.audio_url, title: post.audio_title ?? "مقطع صوتي" } : null;

  // The store returns a primitive string so React can compare snapshots by
  // value (returning a fresh object would re-render forever).
  const snapshot = useSyncExternalStore(
    subscribe,
    () => {
      void version;

      const feedback = interactionCache.has(key)
        ? interactionCache.get(key) ?? null
        : readLocalFeedback(userId)[post.id] ?? null;

      const cachedControls = postCache.get(post.id);
      const localControls = readLocalControls(post.id);

      const commentsDisabled =
        cachedControls?.commentsDisabled ??
        (localControls.commentsDisabled !== undefined
          ? localControls.commentsDisabled
          : Boolean(post.comments_disabled));

      const audio =
        cachedControls?.audio !== undefined
          ? cachedControls.audio ?? null
          : localControls.audio !== undefined
            ? localControls.audio ?? null
            : rowAudio;

      return `${feedback ?? "-"}|${commentsDisabled ? 1 : 0}|${audio?.url ?? "-"}|${audio?.title ?? "-"}`;
    },
    () => "-|0|-|-",
  );

  const [feedbackPart, commentsPart, audioPart, audioTitlePart] = snapshot.split("|");

  const feedback: PostFeedback | null =
    feedbackPart === "interested" || feedbackPart === "not_interested" ? feedbackPart : null;

  const resolvedAudio: PostAudio | null =
    audioPart === "-"
      ? null
      : { url: audioPart, title: audioTitlePart === "-" ? "مقطع صوتي" : audioTitlePart };

  const pending = pendingKeys.has(key) || pendingKeys.has(post.id);

  const setFeedback = useCallback(
    async (value: PostFeedback | null) => {
      const next = readPostFeedback(post.id, userId) === value ? null : value;
      try {
        const result = await setPostFeedback(post.id, userId, next);
        if (!result.persisted) toast.warning(MIGRATION_HINT);
        else if (next === "not_interested") toast.success("سنُظهر لك منشورات أقل مثل هذا");
        else if (next === "interested") toast.success("سنُظهر لك المزيد مثل هذا");
        else toast.success("تم إلغاء التفضيل");
      } catch {
        toast.error("تعذر حفظ التفضيل، حاول مرة أخرى");
      }
    },
    [post.id, userId],
  );

  const toggleComments = useCallback(async () => {
    const current = readCommentsDisabled(post.id, Boolean(post.comments_disabled));
    try {
      const result = await setCommentsDisabled(post.id, !current);
      if (!result.persisted) toast.warning(MIGRATION_HINT);
      else toast.success(!current ? "تم إغلاق التعليقات" : "تم فتح التعليقات");
    } catch {
      toast.error("تعذر تغيير حالة التعليقات");
    }
  }, [post.id, post.comments_disabled]);

  const changeAudio = useCallback(
    async (next: PostAudio | null) => {
      try {
        const result = await setPostAudio(post.id, next);
        if (!result.persisted) toast.warning(MIGRATION_HINT);
        else toast.success(next ? "تم تحديث المقطع الصوتي" : "تم حذف المقطع الصوتي");
      } catch {
        toast.error("تعذر تحديث المقطع الصوتي");
      }
    },
    [post.id],
  );

  return {
    feedback,
    commentsDisabled: commentsPart === "1",
    audio: resolvedAudio,
    pending,
    setFeedback,
    toggleComments,
    changeAudio,
  };
}
