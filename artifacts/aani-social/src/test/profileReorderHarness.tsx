/*
 * Test-only harness for the shared profile preview components.
 *
 * It renders the real ProfileHighlightsRow, ProfileHighlightStoryStrip and
 * ProfileMediaGrid from src/components/profile/ProfileContentPreview.tsx with
 * fixed fixtures and the same pointer wiring Edit Profile uses (a drag handle
 * per reorderable item, long press, elementFromPoint drop target, data
 * attributes) plus the same move-by-one buttons and the aria-live announcement
 * Edit Profile renders. It never talks to Supabase: the order is kept in memory
 * (and localStorage to survive a reload), and every reorder attempt — drag or
 * button — is recorded in window.__profileReorderLog for assertions.
 */
import { useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { createRoot } from 'react-dom/client';

import {
  ProfileHighlightStoryStrip,
  ProfileHighlightsRow,
  ProfileMediaGrid,
  type ReorderBinding,
} from '@/components/profile/ProfileContentPreview';
import type { ProfileHighlightCollection } from '@/components/ProfileHighlightsManager';
import type { Post } from '@/lib/types';
// الأنماط الحقيقية: قواعد إعادة الترتيب تأتي من ProfilePage.css كما في Edit
// Profile، وهذا الملف يضيف هندسة ثابتة فقط (بدون Tailwind في صفحة الاختبار).
import '@/pages/ProfilePage.css';
import './profileReorderHarness.css';

type Kind = 'posts' | 'highlights' | 'stories';
type LogEntry = { kind: Kind; nextIds: string[]; previousIds: string[] };

// نفس تسميات الإعلان في ProfilePage: تُقرأ في نص aria-live.
const LABELS: Record<Kind, string> = {
  posts: 'المنشور',
  highlights: 'المجموعة',
  stories: 'القصة',
};

const OWNER_ID = 'a0000000-0000-4000-8000-00000000000a';
const OTHER_ID = 'b0000000-0000-4000-8000-00000000000b';

const MEDIA_PIXEL = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';

function post(id: string, userId: string, overrides: Partial<Post> = {}): Post {
  return {
    id,
    user_id: userId,
    content: '',
    // getPostCoverUrl reads post_metadata with .find, so it has to be an array.
    post_metadata: [],
    media_url: MEDIA_PIXEL,
    media_urls: [],
    type: 'photo',
    display_order: 0,
    destination: 'feed',
    visibility: 'public',
    hide_likes: false,
    hide_comments: false,
    comment_privacy: 'public',
    created_at: '2026-11-01T00:00:00.000Z',
    likes_count: 0,
    comments_count: 0,
    reposts_count: 0,
    shares_count: 0,
    ...overrides,
  } as unknown as Post;
}

// A text post that the media grid never shows, a repost by another user, and
// three owned media posts in a fixed display order.
const TEXT_POST = post('p-text', OWNER_ID, { type: 'text', media_url: null, content: 'نص فقط' });
const REPOST_POST = post('p-repost', OWNER_ID, { reposter_id: OTHER_ID } as Partial<Post>);
const OWNED_POSTS = [
  post('p-one', OWNER_ID),
  post('p-two', OWNER_ID, { type: 'reel', destination: 'reels' }),
  post('p-three', OWNER_ID),
];

const COLLECTIONS: ProfileHighlightCollection[] = [
  {
    id: 'c-two', user_id: OWNER_ID, title: 'الثانية', created_at: '2026-11-01T00:00:00.000Z', display_order: 1,
    stories: [
      { id: 's-two-1', user_id: OWNER_ID, collection_id: 'c-two', position: 0, media_url: 'https://example.test/s1.jpg', media_type: 'image', caption: null, source_story_id: null, is_close_friends: false, created_at: '2026-11-01T00:00:00.000Z' },
    ],
  },
  {
    id: 'c-one', user_id: OWNER_ID, title: 'الأولى', created_at: '2026-11-01T00:00:00.000Z', display_order: 0,
    stories: [
      { id: 's-one-1', user_id: OWNER_ID, collection_id: 'c-one', position: 0, media_url: 'https://example.test/s2.jpg', media_type: 'image', caption: null, source_story_id: null, is_close_friends: false, created_at: '2026-11-01T00:00:00.000Z' },
      { id: 's-one-2', user_id: OWNER_ID, collection_id: 'c-one', position: 1, media_url: 'https://example.test/s3.jpg', media_type: 'image', caption: null, source_story_id: null, is_close_friends: false, created_at: '2026-11-02T00:00:00.000Z' },
      { id: 's-one-3', user_id: OWNER_ID, collection_id: 'c-one', position: 2, media_url: 'https://example.test/s4.jpg', media_type: 'image', caption: null, source_story_id: null, is_close_friends: false, created_at: '2026-11-03T00:00:00.000Z' },
    ],
  },
];

declare global {
  interface Window {
    __profileReorderLog?: LogEntry[];
    __profileReorderFailNext?: boolean;
  }
}

function move(ids: string[], fromId: string, toId: string): string[] {
  const from = ids.indexOf(fromId);
  const to = ids.indexOf(toId);
  if (from < 0 || to < 0 || from === to) return ids;
  const next = [...ids];
  const [moved] = next.splice(from, 1);
  next.splice(to, 0, moved);
  return next;
}

function readStored<T>(key: string, fallback: T): T {
  try {
    const raw = window.localStorage.getItem(key);
    return raw ? JSON.parse(raw) as T : fallback;
  } catch {
    return fallback;
  }
}

function Harness() {
  const [highlightOrder, setHighlightOrder] = useState<string[]>(() => readStored('test:highlights', COLLECTIONS.map(item => item.id)));
  const [storiesOrder, setStoriesOrder] = useState<Record<string, string[]>>(() => readStored('test:stories', {
    'c-one': COLLECTIONS[1].stories.map(story => story.id),
    'c-two': COLLECTIONS[0].stories.map(story => story.id),
  }));
  const [postOrder, setPostOrder] = useState<string[]>(() => readStored('test:posts', OWNED_POSTS.map(item => item.id)));
  const [selected, setSelected] = useState<string | null>(null);
  const [announcement, setAnnouncement] = useState('');
  const [dragKey, setDragKey] = useState<string | null>(null);
  const [overKey, setOverKey] = useState<string | null>(null);
  const timer = useRef<number | null>(null);
  const gesture = useRef<{ kind: Kind; id: string; x: number; y: number; active: boolean } | null>(null);

  const log = (entry: LogEntry) => {
    window.__profileReorderLog = [...(window.__profileReorderLog ?? []), entry];
  };

  // نفس أثر الحفظ في Edit Profile: تحديث فوري + حفظ (localStorage هنا)
  // واستعادة السابق عند الفشل — مشترك بين السحب وزرّي السابق/التالي.
  const applyOrder = (kind: Kind, nextIds: string[], collectionId: string | null) => {
    if (kind === 'posts') {
      setPostOrder(nextIds);
      window.localStorage.setItem('test:posts', JSON.stringify(nextIds));
    } else if (kind === 'highlights') {
      setHighlightOrder(nextIds);
      window.localStorage.setItem('test:highlights', JSON.stringify(nextIds));
    } else if (collectionId) {
      const next = { ...storiesOrder, [collectionId]: nextIds };
      setStoriesOrder(next);
      window.localStorage.setItem('test:stories', JSON.stringify(next));
    }
  };

  const highlighted = useMemo(() => {
    const byId = new Map(COLLECTIONS.map(item => [item.id, item]));
    return highlightOrder.flatMap(id => byId.has(id) ? [byId.get(id)!] : []);
  }, [highlightOrder]);

  const selectedCollection = highlighted.find(item => item.id === selected) ?? null;
  const selectedStories = selectedCollection
    ? (storiesOrder[selectedCollection.id] ?? []).flatMap(id => {
      const story = selectedCollection.stories.find(item => item.id === id);
      return story ? [story] : [];
    })
    : [];
  const gridPosts = useMemo(() => {
    const byId = new Map(OWNED_POSTS.map(item => [item.id, item]));
    return postOrder.flatMap(id => byId.has(id) ? [byId.get(id)!] : []);
  }, [postOrder]);

  const begin = (event: ReactPointerEvent<HTMLElement>, kind: Kind, id: string) => {
    if (timer.current !== null) window.clearTimeout(timer.current);
    gesture.current = { kind, id, x: event.clientX, y: event.clientY, active: false };
    event.currentTarget.setPointerCapture(event.pointerId);
    timer.current = window.setTimeout(() => {
      if (!gesture.current) return;
      gesture.current.active = true;
      setDragKey(`${kind}:${id}`);
    }, 450);
  };

  const movePointer = (event: ReactPointerEvent<HTMLElement>) => {
    const current = gesture.current;
    if (!current) return;
    if (!current.active) {
      if (Math.hypot(event.clientX - current.x, event.clientY - current.y) > 10) {
        if (timer.current !== null) window.clearTimeout(timer.current);
        gesture.current = null;
      }
      return;
    }
    event.preventDefault();
    const target = document.elementFromPoint(event.clientX, event.clientY)?.closest<HTMLElement>('[data-profile-reorder-kind][data-profile-reorder-id]');
    const kind = target?.dataset.profileReorderKind;
    const id = target?.dataset.profileReorderId;
    setOverKey(kind === current.kind && id ? `${current.kind}:${id}` : null);
  };

  const end = (event: ReactPointerEvent<HTMLElement>) => {
    const current = gesture.current;
    if (!current) return;
    if (timer.current !== null) window.clearTimeout(timer.current);
    gesture.current = null;
    setDragKey(null);
    setOverKey(null);
    if (!current.active) return;
    const target = document.elementFromPoint(event.clientX, event.clientY)?.closest<HTMLElement>('[data-profile-reorder-kind][data-profile-reorder-id]');
    if (target?.dataset.profileReorderKind !== current.kind || !target.dataset.profileReorderId) return;

    const previousIds = current.kind === 'posts'
      ? postOrder
      : current.kind === 'highlights'
        ? highlightOrder
        : (selected ? storiesOrder[selected] ?? [] : []);
    const nextIds = move(previousIds, current.id, target.dataset.profileReorderId);
    if (nextIds === previousIds) return;

    const failing = window.__profileReorderFailNext === true;
    window.__profileReorderFailNext = false;
    log({ kind: current.kind, nextIds, previousIds });
    if (failing) {
      window.__profileReorderLog = [...(window.__profileReorderLog ?? []), { kind: current.kind, nextIds: previousIds, previousIds: nextIds }];
      setAnnouncement(`فشل حفظ الترتيب: بقي ${LABELS[current.kind]} في موضعه السابق.`);
      return;
    }

    applyOrder(current.kind, nextIds, current.kind === 'stories' ? selected : null);
    setAnnouncement(`نُقل ${LABELS[current.kind]} إلى الموضع ${nextIds.indexOf(current.id) + 1} من ${nextIds.length}.`);
  };

  // زرّا السابق/التالي: نفس المسار (تحديث فوري ثم حفظ أو استعادة) بلا سحب.
  const moveByItem = (kind: Kind, id: string, direction: -1 | 1) => {
    const previousIds = kind === 'posts'
      ? postOrder
      : kind === 'highlights'
        ? highlightOrder
        : (selected ? storiesOrder[selected] ?? [] : []);
    const from = previousIds.indexOf(id);
    const to = from + direction;
    // لا خروج عن أول عنصر أو آخره.
    if (from < 0 || to < 0 || to >= previousIds.length) return;
    const nextIds = move(previousIds, id, previousIds[to]);
    if (nextIds === previousIds) return;

    const failing = window.__profileReorderFailNext === true;
    window.__profileReorderFailNext = false;
    log({ kind, nextIds, previousIds });
    if (failing) {
      window.__profileReorderLog = [...(window.__profileReorderLog ?? []), { kind, nextIds: previousIds, previousIds: nextIds }];
      setAnnouncement(`فشل حفظ الترتيب: بقي ${LABELS[kind]} في الموضع ${from + 1} من ${previousIds.length}.`);
      return;
    }

    applyOrder(kind, nextIds, kind === 'stories' ? selected : null);
    setAnnouncement(`نُقل ${LABELS[kind]} إلى الموضع ${to + 1} من ${nextIds.length}.`);
  };

  const cancel = () => {
    if (timer.current !== null) window.clearTimeout(timer.current);
    gesture.current = null;
    setDragKey(null);
    setOverKey(null);
  };

  const binding = (kind: Kind): ReorderBinding => ({
    kind, draggingKey: dragKey, dropTargetKey: overKey, disabled: false,
    begin: (event, _kind, id) => begin(event, kind, id),
    move: movePointer, end, cancel,
    moveBy: (id, direction) => moveByItem(kind, id, direction),
  });

  return (
    <div dir="rtl" style={{ width: 420 }} data-testid="harness-ready" className="profile-reorder-panel profile-reorder-preview">
      <div role="status" aria-live="polite" aria-atomic="true" data-testid="reorder-announcement">{announcement}</div>
      <section aria-label="highlights">
        <ProfileHighlightsRow
          collections={highlighted}
          onSelect={collection => setSelected(collection.id)}
          reorder={binding('highlights')}
        />
      </section>

      {selectedCollection && (
        <section aria-label="collection stories">
          <ProfileHighlightStoryStrip
            collection={{ ...selectedCollection, stories: selectedStories }}
            reorder={binding('stories')}
          />
        </section>
      )}

      <section aria-label="media grid">
        <ProfileMediaGrid
          posts={[...gridPosts, REPOST_POST]}
          reorder={binding('posts')}
          canReorder={item => item.user_id === OWNER_ID && !item.reposter_id}
        />
        {/* خارج الشبكة عمداً: نص وإعادة نشر لا يظهران في شبكة الوسائط */}
        <span data-testid="excluded" data-text={TEXT_POST.id} data-repost={REPOST_POST.id} />
      </section>
    </div>
  );
}

const root = document.getElementById('root')!;

function showHarnessError(message: string) {
  root.innerHTML = '';
  const panel = document.createElement('pre');
  panel.setAttribute('data-testid', 'harness-error');
  panel.style.whiteSpace = 'pre-wrap';
  panel.style.color = '#ff6b6b';
  panel.textContent = `harness failed to mount:\n${message}`;
  root.appendChild(panel);
}

window.addEventListener('error', event => {
  showHarnessError(`${event.message} (${event.filename}:${event.lineno})`);
});
window.addEventListener('unhandledrejection', event => {
  const reason = event.reason instanceof Error ? `${event.reason.stack ?? event.reason.message}` : String(event.reason);
  showHarnessError(`unhandled rejection: ${reason}`);
});

try {
  createRoot(root).render(<Harness />);
} catch (error) {
  showHarnessError(error instanceof Error ? `${error.stack ?? error.message}` : String(error));
}

