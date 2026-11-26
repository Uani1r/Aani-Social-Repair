import { Camera, Copy, Play, Plus } from 'lucide-react';
import type { MouseEvent as ReactMouseEvent, PointerEvent as ReactPointerEvent } from 'react';

import { SignedImage } from '@/components/SignedMedia';
import type { ProfileHighlightCollection } from '@/components/ProfileHighlightsManager';
import { thumbnailUrl } from '@/lib/mediaPreload';
import { getPostCoverUrl, getPostDestination, type Post } from '@/lib/types';

/**
 * معاينة محتوى الملف الشخصي المشتركة بين صفحة Profile وشاشة تعديل الملف.
 *
 * الشبكة وشريط أبرز القصص هنا هما نفس ما يراه زائر الملف الشخصي: نفس المكوّن،
 * نفس الأعمدة الثلاثة، نفس أبعاد المربعات والدوائر، ونفس شارات الفيديو
 * والريلز والنص وتعدد الصور — فلا تنسخ شاشة التعديل تصميماً مخمّناً.
 *
 * في وضع إعادة الترتيب (تمرير reorder) لا تُضاف أي أيقونة أو زر فوق الصورة:
 * العنصر كله — الصورة أو الدائرة وعنوانها — هو سطح السحب. الضغط المطوّل يبدأ
 * السحب، والنقر القصير يبقى يفتح المنشور أو المجموعة أو القصة كما هو.
 *
 * أحداث المؤشر على العنصر نفسه، ويُمنع تمرير الصفحة على Safari من مستمع
 * touchmove غير سلبي في ProfilePage أثناء السحب الفعلي فقط (لا touch-action:
 * none على العناصر)، فتبقى الصفحة قابلة للتمرير قبل اكتمال الضغط المطوّل.
 */

export type ProfileContentVariant = 'posts' | 'videos' | 'reposts' | 'tagged';

export type ReorderBinding = {
  /** نوع إعادة الترتيب في data-profile-reorder-kind (posts / highlights / stories). */
  kind: string;
  draggingKey: string | null;
  dropTargetKey: string | null;
  disabled: boolean;
  begin: (event: ReactPointerEvent<HTMLElement>, kind: string, id: string) => void;
  move: (event: ReactPointerEvent<HTMLElement>) => void;
  end: (event: ReactPointerEvent<HTMLElement>) => void;
  cancel: (event: ReactPointerEvent<HTMLElement>) => void;
  /** يستهلك نقرة تلت سحباً فعلياً حتى لا يفتح العنصر بعد إفلاته. */
  consumeDragClick: () => boolean;
};

type ItemAttributes = {
  'data-profile-reorder-kind': string;
  'data-profile-reorder-id': string;
  onPointerDown: (event: ReactPointerEvent<HTMLButtonElement>) => void;
  onPointerMove: (event: ReactPointerEvent<HTMLButtonElement>) => void;
  onPointerUp: (event: ReactPointerEvent<HTMLButtonElement>) => void;
  onPointerCancel: (event: ReactPointerEvent<HTMLButtonElement>) => void;
  classes: string;
};

/** سمات العنصر القابل للسحب: كل أحداث المؤشر عليه، بلا أي طبقة تحكم فوقه. */
function itemAttributes(binding: ReorderBinding, id: string): ItemAttributes {
  const key = `${binding.kind}:${id}`;
  return {
    'data-profile-reorder-kind': binding.kind,
    'data-profile-reorder-id': id,
    onPointerDown: event => binding.begin(event, binding.kind, id),
    onPointerMove: event => binding.move(event),
    onPointerUp: event => binding.end(event),
    onPointerCancel: event => binding.cancel(event),
    classes: `${binding.draggingKey === key ? ' is-dragging' : ''}${binding.dropTargetKey === key ? ' is-drop-target' : ''}`,
  };
}

/**
 * النقر القصير يفتح العنصر، إلا إذا كان قد أنهى سحباً فعلياً: المتصفح يرسل
 * نقرة بعد كل إفلات، فتُستهلك هنا بدل أن تفتح ما جرى ترتيبه.
 */
function handleItemClick(
  event: ReactMouseEvent<HTMLButtonElement>,
  binding: ReorderBinding | undefined,
  open: () => void,
) {
  if (binding?.consumeDragClick()) {
    event.preventDefault();
    return;
  }
  open();
}

function isReelPost(post: Post): boolean {
  return post.type === 'reel' || getPostDestination(post) === 'reels';
}

/** شبكة 3 أعمدة مطابقة لشبكة Profile: صور/فيديو/ريلز، والمنشورات النصية مستبعدة. */
export function ProfileMediaGrid({
  posts,
  variant = 'posts',
  onOpenPost,
  reorder,
  canReorder,
  className = 'mt-4',
}: {
  posts: Post[];
  variant?: ProfileContentVariant;
  onOpenPost?: (post: Post) => void;
  reorder?: ReorderBinding;
  /** عناصر الشبكة القابلة للترتيب فقط (المنشورات المملوكة) — الباقي بلا سحب. */
  canReorder?: (post: Post) => boolean;
  className?: string;
}) {
  return (
    <div className={`${className} grid grid-cols-3 gap-[2px] bg-black content-fade-in`}>
      {posts.map(post => {
        const isReel = isReelPost(post);
        const mediaUrls = post.media_urls?.length ? post.media_urls : post.media_url ? [post.media_url] : [];
        const cover = mediaUrls[0] || '';
        // الغلاف المختار عند النشر: صورة خفيفة تُعرض بدل عنصر الفيديو
        const postCoverUrl = getPostCoverUrl(post);
        const isMultiImage = mediaUrls.length > 1;
        const draggable = Boolean(reorder) && (!canReorder || canReorder(post));
        const item = draggable ? itemAttributes(reorder!, post.id) : null;
        const actionLabel = variant !== 'posts' || isReel
          ? 'فتح الريل في عارض الملف الشخصي'
          : 'فتح المنشور في عارض الملف الشخصي';

        return (
          <button
            key={post.id}
            type="button"
            onClick={event => handleItemClick(event, draggable ? reorder : undefined, () => onOpenPost?.(post))}
            aria-label={actionLabel}
            data-profile-reorder-kind={item?.['data-profile-reorder-kind']}
            data-profile-reorder-id={item?.['data-profile-reorder-id']}
            onPointerDown={item?.onPointerDown}
            onPointerMove={item?.onPointerMove}
            onPointerUp={item?.onPointerUp}
            onPointerCancel={item?.onPointerCancel}
            className={`relative block aspect-[4/5] overflow-hidden bg-neutral-900 transition-transform duration-150 active:scale-[0.985]${item?.classes ?? ''}`}
          >
            {isReel ? (
              postCoverUrl ? (
                <SignedImage
                  src={thumbnailUrl(postCoverUrl)}
                  alt={post.content.slice(0, 80)}
                  loading="lazy"
                  decoding="async"
                  className="h-full w-full object-cover"
                />
              ) : cover ? (
                <span className="grid h-full w-full place-items-center text-neutral-400"><Play size={28} aria-hidden="true" /></span>
              ) : (
                <span className="grid h-full w-full place-items-center text-neutral-600"><Play size={28} aria-hidden="true" /></span>
              )
            ) : cover ? (
              <SignedImage
                src={thumbnailUrl(cover)}
                alt={post.content.slice(0, 80)}
                loading="lazy"
                decoding="async"
                className="h-full w-full object-cover"
              />
            ) : post.type === 'text' ? (
              <span className="flex h-full w-full items-center justify-center overflow-hidden p-2 text-center text-[11px] leading-5 text-neutral-200">
                {post.content?.slice(0, 90) || 'منشور'}
              </span>
            ) : (
              <span className="grid h-full w-full place-items-center text-neutral-600"><Camera size={24} aria-hidden="true" /></span>
            )}
            {isReel && (
              <span aria-hidden="true" className="absolute right-2 top-2 z-[2] text-white drop-shadow-[0_1px_2px_rgba(0,0,0,0.8)]">
                <svg width="17" height="17" viewBox="0 0 24 24" fill="currentColor"><rect x="2" y="4" width="20" height="16" rx="4" /><path d="M10 9.2v5.6a.8.8 0 0 0 1.22.68l4.4-2.8a.8.8 0 0 0 0-1.36l-4.4-2.8A.8.8 0 0 0 10 9.2Z" fill="black" /></svg>
              </span>
            )}
            {variant === 'reposts' && (
              <span aria-hidden="true" className="absolute left-2 top-2 z-[2] text-white drop-shadow-[0_1px_2px_rgba(0,0,0,0.8)]">
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path strokeLinecap="round" strokeLinejoin="round" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" /></svg>
              </span>
            )}
            {post.type === 'text' && (
              <span aria-hidden="true" className="absolute right-2 top-2 z-[2] rounded-full bg-black/60 px-1.5 py-0.5 text-[10px] font-bold text-white drop-shadow-[0_1px_2px_rgba(0,0,0,0.8)]">نص</span>
            )}
            {isMultiImage && (
              <Copy size={16} aria-hidden="true" fill="white" className="absolute left-2 top-2 z-[2] text-white drop-shadow-[0_1px_2px_rgba(0,0,0,0.8)]" />
            )}
          </button>
        );
      })}
    </div>
  );
}

/** صف أبرز القصص: نفس دوائر Profile (68px) والمسافات واتجاه RTL والأغلفة. */
export function ProfileHighlightsRow({
  collections,
  onSelect,
  onAdd,
  addButtonId,
  reorder,
  ariaLabel = 'أبرز القصص',
}: {
  collections: ProfileHighlightCollection[];
  onSelect: (collection: ProfileHighlightCollection) => void;
  onAdd?: () => void;
  addButtonId?: string;
  reorder?: ReorderBinding;
  ariaLabel?: string;
}) {
  return (
    <div className="no-scrollbar flex items-center gap-4 overflow-x-auto pb-2" aria-label={ariaLabel}>
      {onAdd && (
        <button
          id={addButtonId}
          type="button"
          onClick={onAdd}
          className="flex shrink-0 cursor-pointer flex-col items-center gap-1.5"
          aria-label="إضافة إلى أبرز القصص"
        >
          <span className="flex h-[68px] w-[68px] items-center justify-center rounded-full border border-dashed border-[#71767B] bg-[#111] text-[#1D9BF0] transition hover:border-[#1D9BF0] hover:bg-[#1D9BF0]/10">
            <Plus className="h-7 w-7" aria-hidden="true" />
          </span>
          <span className="max-w-[72px] truncate text-[11px] text-[#BBBBBB]">إضافة</span>
        </button>
      )}
      {collections.map(collection => {
        const cover = collection.stories[0];
        const item = reorder ? itemAttributes(reorder, collection.id) : null;
        return (
          <button
            key={collection.id}
            type="button"
            onClick={event => handleItemClick(event, reorder, () => onSelect(collection))}
            className={`flex shrink-0 cursor-pointer flex-col items-center gap-1.5${item?.classes ?? ''}`}
            aria-label={`عرض مجموعة ${collection.title}`}
            data-profile-reorder-kind={item?.['data-profile-reorder-kind']}
            data-profile-reorder-id={item?.['data-profile-reorder-id']}
            onPointerDown={item?.onPointerDown}
            onPointerMove={item?.onPointerMove}
            onPointerUp={item?.onPointerUp}
            onPointerCancel={item?.onPointerCancel}
          >
            <span className="flex h-[68px] w-[68px] rounded-full border border-[#4B4B50] p-[3px]">
              <span className="flex h-full w-full items-center justify-center overflow-hidden rounded-full bg-neutral-800">
                {collection.cover_url ? (
                  <SignedImage src={collection.cover_url} className="h-full w-full object-cover" alt="" />
                ) : cover?.media_url && cover.media_type === 'video' ? (
                  <span className="grid h-full w-full place-items-center text-neutral-400" aria-hidden="true"><Play size={18} /></span>
                ) : cover?.media_url ? (
                  <SignedImage src={cover.media_url} className="h-full w-full object-cover" alt="" />
                ) : (
                  <span className="line-clamp-3 px-1 text-center text-[9px] text-white">{cover?.caption || collection.title}</span>
                )}
              </span>
            </span>
            <span className="max-w-[88px] truncate text-[11px] text-[#BBBBBB]">{collection.title}</span>
          </button>
        );
      })}
    </div>
  );
}

/** قصص مجموعة واحدة داخل شاشة الترتيب: دوائر بالترتيب الفعلي (position). */
export function ProfileHighlightStoryStrip({
  collection,
  reorder,
  onOpenStory,
}: {
  collection: ProfileHighlightCollection;
  reorder?: ReorderBinding;
  onOpenStory?: (storyId: string) => void;
}) {
  return (
    <div className="no-scrollbar flex items-center gap-3 overflow-x-auto pb-2">
      {collection.stories.map(story => {
        const item = reorder ? itemAttributes(reorder, story.id) : null;
        return (
          <button
            key={story.id}
            type="button"
            onClick={event => handleItemClick(event, reorder, () => onOpenStory?.(story.id))}
            className={`relative flex shrink-0 flex-col items-center gap-1${item?.classes ?? ''}`}
            aria-label="عرض القصة"
            data-profile-reorder-kind={item?.['data-profile-reorder-kind']}
            data-profile-reorder-id={item?.['data-profile-reorder-id']}
            onPointerDown={item?.onPointerDown}
            onPointerMove={item?.onPointerMove}
            onPointerUp={item?.onPointerUp}
            onPointerCancel={item?.onPointerCancel}
          >
            <span className="flex h-[58px] w-[58px] items-center justify-center overflow-hidden rounded-full border border-[#4B4B50] bg-neutral-800">
              {story.media_url && story.media_type === 'video' ? (
                <span className="grid h-full w-full place-items-center text-neutral-300" aria-hidden="true"><Play size={16} /></span>
              ) : story.media_url ? (
                <SignedImage src={story.media_url} className="h-full w-full object-cover" alt="" />
              ) : (
                <span className="line-clamp-2 px-1 text-center text-[9px] text-white">{story.caption || collection.title}</span>
              )}
            </span>
            <span className="max-w-[70px] truncate text-[10px] text-[#BBBBBB]">
              {new Intl.DateTimeFormat('ar', { day: 'numeric', month: 'short' }).format(new Date(story.created_at))}
            </span>
          </button>
        );
      })}
    </div>
  );
}
