export interface ThreadScrollMetrics {
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
}

export const THREAD_SCROLL_EDGE_THRESHOLD = 80;

export function isThreadNearBottom(
  metrics: ThreadScrollMetrics,
  threshold = THREAD_SCROLL_EDGE_THRESHOLD,
): boolean {
  return metrics.scrollHeight - metrics.clientHeight - metrics.scrollTop <= threshold;
}

export function shouldLoadOlderMessagesFromScroll(
  metrics: ThreadScrollMetrics,
  hasOlderMessages: boolean,
  isLoading: boolean,
  userInitiatedUpwardScroll: boolean,
  threshold = THREAD_SCROLL_EDGE_THRESHOLD,
): boolean {
  return hasOlderMessages
    && !isLoading
    && userInitiatedUpwardScroll
    && metrics.scrollTop <= threshold;
}

/** Adjust the current scroll position by the visible anchor's actual layout shift. */
export function scrollTopPreservingAnchor(
  currentScrollTop: number,
  anchorTopBeforeUpdate: number,
  anchorTopAfterUpdate: number,
): number {
  return Math.max(0, currentScrollTop + anchorTopAfterUpdate - anchorTopBeforeUpdate);
}
