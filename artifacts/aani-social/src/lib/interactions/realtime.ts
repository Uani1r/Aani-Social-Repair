import { useEffect } from "react";
import type {
  RealtimeChannel,
  RealtimePostgresChangesPayload,
} from "@supabase/supabase-js";
import { supabase, supabaseConfigured } from "../supabase";
import { hydratePostIds, hydrateSavesCount } from "./hydration";
import { isPending, patchCache, stateOf } from "./store";
import type { RawRow } from "./types";

function optionalNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;

  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }

  return undefined;
}

function handlePostUpdate(
  payload: RealtimePostgresChangesPayload<RawRow>,
  userId: string,
): void {
  const row = (payload.new ?? {}) as RawRow;
  const postId = row.id ? String(row.id) : "";

  if (!postId || isPending(postId, userId)) return;

  const likes = optionalNumber(row.likes_count);
  const comments = optionalNumber(row.comments_count);
  const reposts = optionalNumber(row.reposts_count);
  const shares = optionalNumber(row.shares_count);

  if (
    likes === undefined &&
    comments === undefined &&
    reposts === undefined &&
    shares === undefined
  ) {
    return;
  }

  const current = stateOf(postId, userId);
  patchCache(postId, userId, {
    likes: likes ?? current.likes,
    comments: comments ?? current.comments,
    reposts: reposts ?? current.reposts,
    shares: shares ?? current.shares,
  });
}

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
    const postId = record.post_id ? String(record.post_id) : "";

    if (!postId) return;

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

  // saved_posts is an optional legacy table and is not part of this schema's
  // Realtime publication; bookmarks is the canonical persisted save table.
  (["likes", "comments", "reposts", "bookmarks", "post_shares", "post_feedback"] as const).forEach(
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

  channel = channel.on(
    "postgres_changes",
    { event: "UPDATE", schema: "public", table: "posts" },
    (payload) =>
      handlePostUpdate(
        payload as RealtimePostgresChangesPayload<RawRow>,
        userId,
      ),
  );

  channel.subscribe((status) => {
    if (status === "CHANNEL_ERROR" || status === "TIMED_OUT") {
      console.warn(`[interactions] realtime channel ${status}`);
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
