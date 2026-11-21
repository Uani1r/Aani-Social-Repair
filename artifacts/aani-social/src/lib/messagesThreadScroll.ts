export interface ThreadScrollMetrics {
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
}

export const THREAD_SCROLL_EDGE_THRESHOLD = 80;

export type InitialThreadScrollPhase =
  | 'waiting-for-cache-render'
  | 'waiting-for-server'
  | 'waiting-for-server-render'
  | 'completed'
  | 'cancelled';

export interface InitialThreadScrollState {
  conversationId: string | null;
  phase: InitialThreadScrollPhase;
}

export interface InitialThreadScrollClaim {
  state: InitialThreadScrollState;
  completed: boolean;
  shouldScroll: boolean;
}

export function createInitialThreadScrollState(
  conversationId: string | null,
  hasCachedMessages: boolean,
): InitialThreadScrollState {
  return {
    conversationId,
    phase: conversationId
      ? hasCachedMessages ? 'waiting-for-cache-render' : 'waiting-for-server'
      : 'cancelled',
  };
}

export function markInitialThreadServerLoaded(
  state: InitialThreadScrollState,
  conversationId: string,
): InitialThreadScrollState {
  if (state.conversationId !== conversationId || state.phase !== 'waiting-for-server') return state;
  return { ...state, phase: 'waiting-for-server-render' };
}

/** Claim the one initial scroll only after this conversation's rows are rendered. */
export function claimInitialThreadScroll(
  state: InitialThreadScrollState,
  selectedConversationId: string | undefined,
  threadConversationId: string | null,
  loadStatus: string,
  hasRenderedMessages: boolean,
): InitialThreadScrollClaim {
  if (!selectedConversationId
    || state.conversationId !== selectedConversationId
    || threadConversationId !== selectedConversationId) {
    return { state, completed: false, shouldScroll: false };
  }

  const cacheRendered = state.phase === 'waiting-for-cache-render' && hasRenderedMessages;
  const serverRendered = state.phase === 'waiting-for-server-render' && loadStatus === 'loaded';
  if (!cacheRendered && !serverRendered) return { state, completed: false, shouldScroll: false };

  return {
    state: { ...state, phase: 'completed' },
    completed: true,
    shouldScroll: hasRenderedMessages,
  };
}

export function cancelInitialThreadScroll(
  state: InitialThreadScrollState,
  conversationId: string | undefined,
): InitialThreadScrollState {
  if (state.conversationId !== conversationId
    || state.phase === 'completed'
    || state.phase === 'cancelled') return state;
  return { ...state, phase: 'cancelled' };
}

export function isCurrentThreadLoad(
  requestId: number,
  currentRequestId: number,
  requestedConversationId: string,
  selectedConversationId: string | undefined,
): boolean {
  return requestId === currentRequestId && requestedConversationId === selectedConversationId;
}

export function isThreadNearBottom(
  metrics: ThreadScrollMetrics,
  threshold = THREAD_SCROLL_EDGE_THRESHOLD,
): boolean {
  return metrics.scrollHeight - metrics.clientHeight - metrics.scrollTop <= threshold;
}

export function isUserInitiatedUpwardScroll(
  previousScrollTop: number,
  currentScrollTop: number,
  userScrollActive: boolean,
  upwardIntent: boolean,
): boolean {
  return userScrollActive && upwardIntent && currentScrollTop < previousScrollTop;
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
