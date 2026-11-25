import { Camera, Copy, Play, Plus } from 'lucide-react';
import type { PointerEvent as ReactPointerEvent } from 'react';

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
 * وضع السحب اختياري: عند تمرير reorder تصبح العناصر قابلة للسحب والإفلات
 * (Pointer Events تعمل باللمس والماوس) مع تمييز موضع الإسقاط، ونفس التخطيط
 * البصري تماماً خارج ذلك.
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
};

type ReorderProps = {
  'data-profile-reorder-kind'?: string;
  'data-profile-reorder-id'?: string;
  onPointerDown?: (event: ReactPointerEvent<HTMLElement>) => void;
  onPointerMove?: (event: ReactPointerEvent<HTMLElement>) => void;
  onPointerUp?: (event: ReactPointerEvent<HTMLElement>) => void;
  onPointerCancel?: (event: ReactPointerEvent<HTMLElement>) => void;
  disabled?: boolean;
  classes?: string;
};

function reorderProps(binding: ReorderBinding | undefined, id: string): ReorderProps {
  if (!binding) return {};
  const key = `${binding.kind}:${id}`;
  const classes = `${binding.draggingKey === key ? ' is-dragging' : ''}${binding.dropTargetKey === key ? ' is-drop-target' : ''}`;
  return {
    'data-profile-reorder-kind': binding.kind,
    'data-profile-reorder-id': id,
    onPointerDown: (event: ReactPointerEvent<HTMLElement>) => binding.begin(event, binding.kind, id),
    onPointerMove: binding.move,
    onPointerUp: binding.end,
    onPointerCancel: binding.cancel,
    disabled: binding.disabled,
    classes,
  };
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
  className = 'mt-4',
}: {
  posts: Post[];
  variant?: ProfileContentVariant;
  onOpenPost?: (post: Post) => void;
  reorder?: ReorderBinding;
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
        const drag = reorderProps(reorder, post.id);
        return (
          <button
            key={post.id}
            type="button"
            onClick={() => { if (!reorder) onOpenPost?.(post); }}
            aria-label={reorder
              ? `اسحب لإعادة ترتيب المنشور: ${post.content || 'منشور وسائط'}`
              : variant !== 'posts' || isReel
                ? 'فتح الريل في عارض الملف الشخصي'
                : 'فتح المنشور في عارض الملف الشخصي'}
            data-profile-reorder-kind={drag['data-profile-reorder-kind']}
            data-profile-reorder-id={drag['data-profile-reorder-id']}
            onPointerDown={drag.onPointerDown}
            onPointerMove={drag.onPointerMove}
            onPointerUp={drag.onPointerUp}
            onPointerCancel={drag.onPointerCancel}
            disabled={drag.disabled}
            className={`relative block aspect-[4/5] overflow-hidden bg-neutral-900 transition-transform duration-150 active:scale-[0.985]${drag.classes ?? ''}`}
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
        const drag = reorderProps(reorder, collection.id);
        return (
          <button
            key={collection.id}
            type="button"
            onClick={() => onSelect(collection)}
            className={`flex shrink-0 cursor-pointer flex-col items-center gap-1.5${drag.classes ?? ''}`}
            aria-label={reorder ? `اسحب لإعادة ترتيب مجموعة ${collection.title}` : `عرض مجموعة ${collection.title}`}
            data-profile-reorder-kind={drag['data-profile-reorder-kind']}
            data-profile-reorder-id={drag['data-profile-reorder-id']}
            onPointerDown={drag.onPointerDown}
            onPointerMove={drag.onPointerMove}
            onPointerUp={drag.onPointerUp}
            onPointerCancel={drag.onPointerCancel}
            disabled={drag.disabled}
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
        const drag = reorderProps(reorder, story.id);
        return (
          <button
            key={story.id}
            type="button"
            onClick={() => onOpenStory?.(story.id)}
            className={`relative flex shrink-0 flex-col items-center gap-1${drag.classes ?? ''}`}
            aria-label={reorder ? 'اسحب لإعادة ترتيب القصة داخل المجموعة' : 'عرض القصة'}
            data-profile-reorder-kind={drag['data-profile-reorder-kind']}
            data-profile-reorder-id={drag['data-profile-reorder-id']}
            onPointerDown={drag.onPointerDown}
            onPointerMove={drag.onPointerMove}
            onPointerUp={drag.onPointerUp}
            onPointerCancel={drag.onPointerCancel}
            disabled={drag.disabled}
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
