export interface ContentRefreshEventDetail {
  waitUntil: (request: Promise<unknown>) => void;
}

export function registerContentRefreshRequest(event: Event, request: Promise<unknown>): void {
  const detail = (event as CustomEvent<ContentRefreshEventDetail>).detail;
  if (typeof detail?.waitUntil === 'function') detail.waitUntil(request);
}

export function requestContentRefresh(): Promise<void> {
  if (typeof window === 'undefined') return Promise.resolve();

  const requests: Promise<unknown>[] = [];
  window.dispatchEvent(new CustomEvent<ContentRefreshEventDetail>('aani:content-refresh', {
    detail: { waitUntil: request => requests.push(Promise.resolve(request)) },
  }));

  return Promise.allSettled(requests).then(() => undefined);
}
