import { useEffect } from "react";
import type {
  RealtimeChannel,
  RealtimePostgresChangesPayload,
} from "@supabase/supabase-js";
import { supabase, supabaseConfigured } from "../supabase";
import { hydratePostIds, hydrateSavesCount } from "./hydration";
import { patchCache } from "./store";
import type { RawRow } from "./types";

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

  // Reconcile counters from interaction rows, not posts.*_count updates: a
  // counter-column event can arrive before the authoritative row-based summary
  // and briefly double an optimistic count.
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
