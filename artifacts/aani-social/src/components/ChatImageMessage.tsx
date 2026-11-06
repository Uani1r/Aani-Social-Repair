import { useState } from 'react';
import { createPortal } from 'react-dom';
import { Eye, X } from 'lucide-react';

type ChatMediaPayload = {
  urls: string[];
  caption: string;
  viewOnce: boolean;
};

export const CHAT_MEDIA_MESSAGE_PREFIX = '[aani-image:v1]';

export function parseChatMediaMessage(content: string): ChatMediaPayload | null {
  if (!content.startsWith(CHAT_MEDIA_MESSAGE_PREFIX)) return null;
  try {
    const parsed: unknown = JSON.parse(content.slice(CHAT_MEDIA_MESSAGE_PREFIX.length));
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
    const value = parsed as Record<string, unknown>;
    const urls = Array.isArray(value.urls) ? value.urls.filter((url): url is string => typeof url === 'string' && /^https?:\/\//i.test(url)) : [];
    if (!urls.length) return null;
    return {
      urls,
      caption: typeof value.caption === 'string' ? value.caption : '',
      viewOnce: value.viewOnce === true,
    };
  } catch {
    return null;
  }
}

function hasViewedOnce(userId: string, messageId: string): boolean {
  if (typeof window === 'undefined') return false;
  try {
    return window.localStorage.getItem(`aani_view_once_${userId}_${messageId}`) === '1';
  } catch {
    return false;
  }
}

export default function ChatImageMessage({
  messageId,
  currentUserId,
  payload,
  isMine,
}: {
  messageId: string;
  currentUserId: string;
  payload: ChatMediaPayload;
  isMine: boolean;
}) {
  const [viewed, setViewed] = useState(() => payload.viewOnce && hasViewedOnce(currentUserId, messageId));
  const [viewerOpen, setViewerOpen] = useState(false);

  const closeViewer = () => {
    setViewerOpen(false);
    if (!payload.viewOnce) return;
    try {
      window.localStorage.setItem(`aani_view_once_${currentUserId}_${messageId}`, '1');
    } catch {
      /* قد يكون التخزين المحلي غير متاح */
    }
    setViewed(true);
  };

  const openViewer = () => {
    if (!viewed) setViewerOpen(true);
  };

  return (
    <div className={`messages-image-message${isMine ? ' is-mine' : ' is-theirs'}`}>
      {payload.viewOnce ? (
        viewed ? (
          <div className="messages-image-once-viewed"><Eye size={17} /><span>تم عرض الصورة مرة واحدة</span></div>
        ) : (
          <button type="button" className="messages-image-once-button" onClick={openViewer}>
            <span className="messages-image-once-icon"><Eye size={20} /><b>1</b></span>
            <span>{payload.urls.length > 1 ? `عرض ${payload.urls.length} صور مرة واحدة` : 'عرض الصورة مرة واحدة'}</span>
          </button>
        )
      ) : (
        <div className={`messages-image-grid${payload.urls.length > 1 ? ' has-multiple' : ''}`}>
          {payload.urls.map((url, index) => (
            <button key={`${messageId}-${index}`} type="button" onClick={openViewer} aria-label={`عرض الصورة ${index + 1}`}>
              <img src={url} alt={`صورة مرسلة ${index + 1}`} loading="lazy" />
            </button>
          ))}
        </div>
      )}
      {payload.caption && <div className={`messages-image-caption messages-bubble ${isMine ? 'is-mine' : 'is-theirs'}`}>{payload.caption}</div>}

      {viewerOpen && createPortal(
        <div className="messages-media-viewer" role="dialog" aria-modal="true" aria-label="عرض الصورة" onClick={closeViewer}>
          <button type="button" className="messages-media-viewer-close" aria-label="إغلاق الصورة" onClick={closeViewer}><X size={26} /></button>
          <div className="messages-media-viewer-content" onClick={event => event.stopPropagation()}>
            {payload.urls.map((url, index) => <img key={`${messageId}-full-${index}`} src={url} alt={`صورة ${index + 1}`} draggable={false} />)}
            {payload.viewOnce && <span className="messages-media-viewer-once"><Eye size={15} /> تُعرض مرة واحدة</span>}
          </div>
        </div>,
        document.body,
      )}
    </div>
  );
}
