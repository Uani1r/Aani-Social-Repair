import { useEffect } from "react";
import type {
  RealtimeChannel,
  RealtimePostgresChangesPayload,
} from "@supabase/supabase-js";
import { handleAppError } from "../appErrors";
import { supabase, supabaseConfigured } from "../supabase";
import { hydratePostIds, hydrateSavesCount } from "./hydration";
import { patchCache } from "./store";
import type { InteractionSnapshot, RawRow } from "./types";

function buildChannel(userId: string): { dispose: () => void } {
  const dirtyPosts = new Set<string>();
  let flushTimer: ReturnType<typeof setTimeout> | null = null;

  const scheduleHydration = () => {
    if (flushTimer) return;

    flushTimer = setTimeout(() => {
      flushTimer = null;
      const ids = Array.from(dirtyPosts);
      dirtyPosts.clear();

      if (ids.length > 0) {
        void hydratePostIds(ids, userId, { force: true });
      }
    }, 450);
  };

  const handleChange = (
    payload: RealtimePostgresChangesPayload<RawRow>,
    table: string,
  ) => {
    const record = (payload.new ?? payload.old ?? {}) as RawRow;
    const postId = String(
      table === "posts" ? record.id ?? "" : record.post_id ?? "",
    );

    if (!postId) return;

    if (table === "reposts" && typeof window !== "undefined") {
      window.dispatchEvent(new Event("aani:repost-changed"));
    }

    if (table === "posts") {
      const counts: Partial<Pick<InteractionSnapshot, "likes" | "comments" | "reposts" | "shares">> = {};
      if (typeof record.likes_count === "number") counts.likes = record.likes_count;
      if (typeof record.comments_count === "number") counts.comments = record.comments_count;
      if (typeof record.reposts_count === "number") counts.reposts = record.reposts_count;
      if (typeof record.shares_count === "number") counts.shares = record.shares_count;
      patchCache(postId, userId, counts);
    }

    dirtyPosts.add(postId);
    scheduleHydration();

    if (table === "bookmarks") {
      void hydrateSavesCount([postId], userId);
      if (typeof window !== "undefined") {
        window.dispatchEvent(
          new CustomEvent("aani:saved-posts-changed", {
            detail: { userId, postId },
          }),
        );
      }
    }
  };

  let channel: RealtimeChannel = supabase.channel(`aani-interactions-${userId}`);

  // Posts exposes safe aggregate columns through its select grants, so its
  // counter updates can reach every viewer without exposing interaction rows.
  // Interaction rows remain subscribed for per-user flags and reconciliation.
  // saved_posts is an optional legacy table; bookmarks is canonical.
  (["posts", "likes", "comments", "reposts", "bookmarks", "post_shares", "post_feedback"] as const).forEach(
    (table) => {
      channel = channel.on(
        "postgres_changes",
        { event: "*", schema: "public", table },
        (payload) =>
          handleChange(
            payload as RealtimePostgresChangesPayload<RawRow>,
            table,
          ),
      );
    },
  );

  channel.subscribe((status) => {
    if (status === "CHANNEL_ERROR" || status === "TIMED_OUT") {
      handleAppError(
        'فشل تحديث التفاعلات المباشرة',
        new Error(`Realtime channel ${status}`),
        'تعذر تحديث الإعجابات والتعليقات مباشرة. تحقق من الاتصال.',
      );
    }
  });

  return {
    dispose: () => {
      if (flushTimer) {
        clearTimeout(flushTimer);
        flushTimer = null;
      }
      dirtyPosts.clear();
      void supabase.removeChannel(channel);
    },
  };
}

export function useInteractionRealtime(
  userId: string | null | undefined,
): void {
  useEffect(() => {
    if (!supabaseConfigured || !userId) return;

    const channel = buildChannel(userId);
    return channel.dispose;
  }, [userId]);
}
