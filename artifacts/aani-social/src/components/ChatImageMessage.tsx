import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Eye, X } from 'lucide-react';
import { toast } from 'sonner';

import EmojiText from '@/components/TwemojiText';

type ChatMediaPayload = {
  urls: string[];
  caption: string;
  viewOnce: boolean;
  opened?: boolean;
};

export const CHAT_MEDIA_MESSAGE_PREFIX = '[aani-image:v1]';

export function parseChatMediaMessage(content: string): ChatMediaPayload | null {
  if (!content.startsWith(CHAT_MEDIA_MESSAGE_PREFIX)) return null;
  try {
    const parsed: unknown = JSON.parse(content.slice(CHAT_MEDIA_MESSAGE_PREFIX.length));
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
    const value = parsed as Record<string, unknown>;
    const urls = Array.isArray(value.urls) ? value.urls.filter((url): url is string => typeof url === 'string' && /^https?:\/\//i.test(url)) : [];
    const viewOnce = value.viewOnce === true;
    const opened = value.opened === true;
    if (!urls.length && !(viewOnce && opened)) return null;
    return {
      urls,
      caption: typeof value.caption === 'string' ? value.caption : '',
      viewOnce,
      opened,
    };
  } catch {
    return null;
  }
}

export function hasViewedOnce(userId: string, messageId: string): boolean {
  if (typeof window === 'undefined') return false;
  try {
    return window.localStorage.getItem(`aani_view_once_${userId}_${messageId}`) === '1';
  } catch {
    return false;
  }
}

export function openedChatMediaContent(content: string): string {
  const payload = parseChatMediaMessage(content);
  if (!payload?.viewOnce) return content;
  return `${CHAT_MEDIA_MESSAGE_PREFIX}${JSON.stringify({ urls: [], caption: '', viewOnce: true, opened: true })}`;
}

function formatMessageTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return new Intl.DateTimeFormat('en', { hour: '2-digit', minute: '2-digit', hour12: false }).format(date);
}

export default function ChatImageMessage({
  messageId,
  currentUserId,
  payload,
  isMine,
  createdAt,
  onViewOnceOpened,
}: {
  messageId: string;
  currentUserId: string;
  payload: ChatMediaPayload;
  isMine: boolean;
  createdAt: string;
  onViewOnceOpened: (messageId: string, urls: string[]) => void;
}) {
  const [viewed, setViewed] = useState(() => payload.viewOnce && (payload.opened === true || hasViewedOnce(currentUserId, messageId)));
  const [viewerOpen, setViewerOpen] = useState(false);
  const [viewerOpening, setViewerOpening] = useState(false);
  const [viewerLoading, setViewerLoading] = useState(false);
  const [viewerUrls, setViewerUrls] = useState<string[]>([]);
  const viewerOpenRequestRef = useRef(0);
  const viewerFetchAbortRef = useRef<AbortController | null>(null);
  const blobUrlsRef = useRef<string[]>([]);
  const viewerImagesRef = useRef<Array<HTMLImageElement | null>>([]);

  const registerViewed = useCallback(() => {
    if (!payload.viewOnce) return;
    try {
      window.localStorage.setItem(`aani_view_once_${currentUserId}_${messageId}`, '1');
    } catch {
      /* قد يكون التخزين المحلي غير متاح */
    }
    setViewed(true);
    onViewOnceOpened(messageId, payload.urls);
  }, [currentUserId, messageId, onViewOnceOpened, payload.urls, payload.viewOnce]);
  const registerViewedRef = useRef(registerViewed);
  const shouldConsumeOnCloseRef = useRef(false);

  useEffect(() => { registerViewedRef.current = registerViewed; }, [registerViewed]);

  const closeViewer = useCallback(() => {
    const shouldConsumeOnClose = shouldConsumeOnCloseRef.current;
    shouldConsumeOnCloseRef.current = false;
    viewerOpenRequestRef.current += 1;
    viewerFetchAbortRef.current?.abort();
    viewerFetchAbortRef.current = null;
    setViewerOpen(false);
    setViewerOpening(false);
    setViewerLoading(false);
    setViewerUrls([]);
    viewerImagesRef.current.forEach(image => image?.removeAttribute('src'));
    viewerImagesRef.current = [];
    blobUrlsRef.current.forEach(url => URL.revokeObjectURL(url));
    blobUrlsRef.current = [];
    if (shouldConsumeOnClose) registerViewedRef.current();
  }, []);

  const openViewer = useCallback(async () => {
    if ((!isMine && (viewed || payload.opened)) || viewerOpening || !payload.urls.length) return;
    const requestId = ++viewerOpenRequestRef.current;
    viewerFetchAbortRef.current?.abort();
    setViewerOpening(true);
    let nextUrls = payload.urls;

    if (payload.viewOnce) {
      const abortController = new AbortController();
      viewerFetchAbortRef.current = abortController;
      setViewerLoading(true);
      shouldConsumeOnCloseRef.current = !isMine;
      setViewerOpen(true);
      const temporaryUrls: string[] = [];
      try {
        for (const url of payload.urls) {
          const response = await fetch(url, { cache: 'no-store', referrerPolicy: 'no-referrer', signal: abortController.signal });
          if (!response.ok) throw new Error('تعذر تحميل الصورة المؤقتة');
          const blob = await response.blob();
          if (requestId !== viewerOpenRequestRef.current) {
            temporaryUrls.forEach(url => URL.revokeObjectURL(url));
            return;
          }
          temporaryUrls.push(URL.createObjectURL(blob));
        }
        if (viewerFetchAbortRef.current === abortController) viewerFetchAbortRef.current = null;
        if (requestId !== viewerOpenRequestRef.current) {
          temporaryUrls.forEach(url => URL.revokeObjectURL(url));
          return;
        }
        nextUrls = temporaryUrls;
        blobUrlsRef.current = temporaryUrls;
      } catch {
        temporaryUrls.forEach(url => URL.revokeObjectURL(url));
        if (viewerFetchAbortRef.current === abortController) viewerFetchAbortRef.current = null;
        if (requestId !== viewerOpenRequestRef.current) return;
        shouldConsumeOnCloseRef.current = false;
        setViewerOpen(false);
        setViewerLoading(false);
        setViewerOpening(false);
        toast.error('تعذر تحميل الصورة المؤقتة بأمان. حاول مرة أخرى.');
        return;
      }
    }

    if (requestId !== viewerOpenRequestRef.current) {
      if (payload.viewOnce) nextUrls.forEach(url => URL.revokeObjectURL(url));
      return;
    }
    setViewerUrls(nextUrls);
    if (payload.viewOnce) shouldConsumeOnCloseRef.current = !isMine;
    setViewerOpen(true);
    setViewerLoading(false);
    setViewerOpening(false);
  }, [isMine, payload.opened, payload.urls, payload.viewOnce, viewed, viewerOpening]);

  const closeViewerRef = useRef(closeViewer);
  useEffect(() => { closeViewerRef.current = closeViewer; }, [closeViewer]);

  useEffect(() => {
    if (!viewerOpen) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const previousState = window.history.state && typeof window.history.state === 'object'
      ? window.history.state as Record<string, unknown>
      : {};
    window.history.pushState({ ...previousState, aaniChatImageViewer: messageId }, '');
    let historyEntryActive = true;

    const handleBack = () => {
      historyEntryActive = false;
      closeViewerRef.current();
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      closeViewerRef.current();
    };
    const handleVisibilityChange = () => {
      if (document.hidden) closeViewerRef.current();
    };

    window.addEventListener('popstate', handleBack);
    window.addEventListener('keydown', handleKeyDown);
    document.addEventListener('visibilitychange', handleVisibilityChange);
    return () => {
      window.removeEventListener('popstate', handleBack);
      window.removeEventListener('keydown', handleKeyDown);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      document.body.style.overflow = previousOverflow;
      if (historyEntryActive) window.history.back();
    };
  }, [messageId, viewerOpen]);

  useEffect(() => () => {
    blobUrlsRef.current.forEach(url => URL.revokeObjectURL(url));
    blobUrlsRef.current = [];
  }, []);

  const messageTime = formatMessageTime(createdAt);

  return (
    <div className={`messages-image-message${isMine ? ' is-mine' : ' is-theirs'}`}>
      {payload.viewOnce ? (
        viewed || payload.opened ? (
          <div className="messages-image-once-viewed" dir="rtl">
            <span>تم الفتح</span>
            {messageTime && <time>{messageTime}</time>}
          </div>
        ) : (
          <button type="button" className="messages-image-once-button" onClick={() => void openViewer()} disabled={viewerOpening} aria-label="عرض الصورة المؤقتة" aria-busy={viewerOpening} dir="rtl">
            <span className="messages-image-once-icon"><Eye size={18} /><b>1</b></span>
            <span>صورة مؤقتة</span>
            {messageTime && <time>{messageTime}</time>}
          </button>
        )
      ) : (
        <div className={`messages-image-grid${payload.urls.length > 1 ? ' has-multiple' : ''}`}>
          {payload.urls.map((url, index) => (
            <button key={`${messageId}-${index}`} type="button" onClick={() => void openViewer()} aria-label={`عرض الصورة ${index + 1}`}>
              <img src={url} alt={`صورة مرسلة ${index + 1}`} loading="lazy" />
            </button>
          ))}
        </div>
      )}
      {payload.caption && <div className={`messages-image-caption messages-bubble ${isMine ? 'is-mine' : 'is-theirs'}`}><EmojiText text={payload.caption} /></div>}

      {viewerOpen && createPortal(
        <div
          className="messages-media-viewer"
          role="dialog"
          aria-modal="true"
          aria-label="عرض الصورة"
          aria-busy={viewerLoading}
          onContextMenu={event => event.preventDefault()}
          onDragStart={event => event.preventDefault()}
        >
          <button type="button" className="messages-media-viewer-close" aria-label="إغلاق الصورة" onClick={closeViewer}><X size={18} /></button>
          {viewerLoading && (
            <div className="messages-media-viewer-loading" role="status" aria-label="جارٍ تحميل الصورة">
              <span className="messages-media-pending-spinner" />
            </div>
          )}
          <div className="messages-media-viewer-content" dir="ltr">
            {viewerUrls.map((url, index) => (
              <img
                key={`${messageId}-full-${index}`}
                ref={element => { viewerImagesRef.current[index] = element; }}
                src={url}
                alt="صورة مؤقتة"
                draggable={false}
                onContextMenu={event => event.preventDefault()}
                onDragStart={event => event.preventDefault()}
              />
            ))}
          </div>
        </div>,
        document.body,
      )}
    </div>
  );
}
