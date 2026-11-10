import React from 'react';
import { Link } from 'wouter';
import { Bookmark, Heart, MessageCircle, Share2 } from 'lucide-react';

import { usePostInteractions } from '../lib/interactions';
import { displayName, getPostCoverUrl, type Post } from '../lib/types';
import UserIdentity from './UserIdentity';
import RepostIcon from './RepostIcon';
import PostMetadataChips from './PostMetadataChips';
import ExpandablePostText from './ExpandablePostText';
import PostImagePreview from './PostImagePreview';
import PostVideoPreview from './PostVideoPreview';
import LikesListSheet from './LikesListSheet';
import { getImageMediaAspectRatio, getVideoAspectRatio, parseVideoCrop } from '../lib/videoMedia';

export interface PostCardProps {
  post: Post;
  currentUserId: string;
  onRefresh?: () => void;
  onOpenComments?: (postId: string, initialCount?: number) => void;
}

export default function PostCard({
  post,
  currentUserId,
  onRefresh,
  onOpenComments,
}: PostCardProps) {
  const [showLikesSheet, setShowLikesSheet] = React.useState(false);

  // 1. حماية من انهيار الشاشة إذا كانت بيانات المنشور فارغة
  if (!post || !post.id) {
    return null;
  }

  // 2. استدعاء آمن مع قيم افتراضية لمنع الشاشة البيضاء
  const interactions = usePostInteractions ? usePostInteractions(post, currentUserId || '') : null;

  const likes = interactions?.likes ?? post.likes_count ?? post.likes?.length ?? 0;
  const comments = interactions?.comments ?? post.comments_count ?? 0;
  const reposts = interactions?.reposts ?? post.reposts_count ?? 0;
  const saves = interactions?.saves ?? 0;
  const shares = interactions?.shares ?? 0;
  const likesVisible = !post.hide_likes || post.user_id === currentUserId;
  const commentsVisible = !post.hide_comments || post.user_id === currentUserId;
  const liked = interactions?.liked ?? (post.likes || []).some((l) => l.user_id === currentUserId);
  const bookmarked = interactions?.bookmarked ?? false;
  const reposted = interactions?.reposted ?? false;
  const shared = interactions?.shared ?? false;
  const pending = interactions?.pending ?? false;

  const toggleLike = interactions?.toggleLike || (() => {});
  const toggleBookmark = interactions?.toggleBookmark || (() => {});
  const toggleRepost = interactions?.toggleRepost || (() => {});
  const share = interactions?.share || (() => {});

  const handleOpenComments = () => {
    if (onOpenComments) {
      onOpenComments(post.id, comments);
    }
  };

  // 3. تنسيق تاريخ آمن لا يسبب خطأ
  const formattedDate = post.created_at
    ? new Date(post.created_at).toLocaleDateString('ar-EG')
    : '';
  const postImages = (post.media_urls || []).filter(Boolean);
  if (postImages.length === 0 && post.media_url) postImages.push(post.media_url);
  const postCoverUrl = getPostCoverUrl(post);
  // تنسيق الإشارة في رأس المنشور (غير متاح للمنشورات النصية)
  const taggedMention = post.type !== 'text'
    ? (post.post_metadata || []).find(tag => tag.kind === 'mention' && tag.profileId) || null
    : null;
  // نسبة أبعاد الوسيط المخزنة مع الرابط عند النشر (4:5 / 3:4 / 9:16)
  const mediaAspect = postImages.length > 0
    ? (post.type === 'reel'
      ? getVideoAspectRatio(parseVideoCrop(postImages[0] || ''))
      : getImageMediaAspectRatio(postImages[0] || ''))
    : undefined;

  return (
    <div className="rounded-2xl border border-zinc-800 bg-zinc-900 p-4 text-white shadow-sm" dir="rtl">
      {/* رأس المنشور */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-4">
          {post.author?.avatar_url ? (
            <img
              src={post.author.avatar_url}
              alt={displayName(post.author)}
              className="h-10 w-10 rounded-full object-cover ring-1 ring-zinc-700"
            />
          ) : (
            <div className="flex h-10 w-10 items-center justify-center rounded-full bg-gradient-to-br from-pink-500 to-violet-600 text-sm font-bold text-white">
              {displayName(post.author).charAt(0) || 'آ'}
            </div>
          )}
          <div className="min-w-0">
            <UserIdentity
              name={
                <>
                  <Link href={`/profile/${post.user_id}`} className="hover:underline">{displayName(post.author)}</Link>
                  {taggedMention?.profileId && (
                    <>
                      <span className="mx-1 font-normal text-zinc-400">و</span>
                      <Link href={`/profile/${encodeURIComponent(taggedMention.profileId)}`} className="text-zinc-300 hover:underline">
                        {taggedMention.displayName || taggedMention.label}
                      </Link>
                    </>
                  )}
                </>
              }
              username={
                taggedMention?.profileId ? (
                  <>
                    <Link href={`/profile/${post.user_id}`} className="hover:underline">{post.author?.username}</Link>
                    <span className="mx-1 font-normal">و</span>
                    <Link href={`/profile/${encodeURIComponent(taggedMention.profileId)}`} className="hover:underline">@{taggedMention.label}</Link>
                  </>
                ) : post.author?.username
              }
              nameClassName="font-semibold text-zinc-100"
              usernameClassName="text-xs text-zinc-400"
            />
            <div className="mt-1 whitespace-nowrap text-xs text-zinc-400">{formattedDate}</div>
          </div>
        </div>
      </div>

      {/* مرفقات الوسائط */}
      {postImages.length > 0 && (
        <div
          className="mt-3 flex aspect-[4/5] w-full gap-2 overflow-x-auto rounded-xl no-scrollbar"
          style={mediaAspect ? { aspectRatio: String(mediaAspect) } : undefined}
        >
          {postImages.map((url, index) => (
            <div key={`${url}-${index}`} className="relative h-full min-w-full shrink-0 overflow-hidden rounded-xl border border-zinc-800">
              {post.type === 'reel' ? (
                <PostVideoPreview src={url} poster={postCoverUrl || undefined} controls className="block h-full w-full object-cover" />
              ) : (
                <PostImagePreview
                  src={url}
                  alt={`صورة المنشور ${index + 1}`}
                  className="block h-full w-full object-cover"
                />
              )}
            </div>
          ))}
        </div>
      )}

      {/* محتوى المنشور */}
      {post.content && (
        <ExpandablePostText
          text={post.content}
          maxLines={post.type === 'text' ? 7 : 2}
          className="mt-3 text-sm leading-6 text-zinc-200"
        />
      )}
      <PostMetadataChips tags={post.post_metadata || []} className="mt-2.5" />

      {/* شريط الأزرار */}
      <div className="mt-4 flex items-center justify-between border-t border-zinc-800/60 pt-3 text-zinc-300">
        <div className="flex items-center gap-2 sm:gap-3">
          <div className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-xs font-medium transition ${
            liked
              ? 'bg-pink-500/15 text-pink-400 hover:bg-pink-500/20'
              : 'bg-zinc-800/80 text-zinc-300 hover:bg-zinc-800 hover:text-white'
          }`}>
            <button
              type="button"
              onClick={toggleLike}
              disabled={pending}
              aria-pressed={liked}
              aria-label={liked ? 'إلغاء الإعجاب' : 'إعجاب'}
              className="inline-flex items-center justify-center border-0 bg-transparent p-0 text-inherit disabled:opacity-50"
            >
              <Heart
                size={16}
                fill={liked ? 'currentColor' : 'none'}
                className={liked ? 'text-pink-500' : ''}
              />
            </button>
            {likesVisible && (post.hide_likes ? (
              <span className="cursor-default text-[11px]">{likes}</span>
            ) : (
              <button
                type="button"
                onClick={() => setShowLikesSheet(true)}
                className="border-0 bg-transparent p-0 text-[11px] text-inherit"
                aria-label="عرض قائمة الإعجابات"
              >
                {likes}
              </button>
            ))}
          </div>

          {commentsVisible && (
            <button
              type="button"
              onClick={handleOpenComments}
              className="inline-flex items-center gap-1.5 rounded-full bg-zinc-800/80 px-3 py-1.5 text-xs font-medium text-zinc-300 transition hover:bg-zinc-800 hover:text-white"
            >
              <MessageCircle size={16} />
              <span className="text-[11px]">{comments}</span>
            </button>
          )}

          <button
            type="button"
            onClick={toggleRepost}
            disabled={pending}
            aria-pressed={reposted}
            className="inline-flex items-center gap-1.5 rounded-full bg-zinc-800/80 px-3 py-1.5 text-xs font-medium text-zinc-300 transition hover:bg-zinc-800 hover:text-white"
          >
            <RepostIcon active={reposted} size={16} />
            <span className="text-[11px]">{reposts}</span>
          </button>

          <button
            type="button"
            onClick={share}
            className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-xs font-medium transition ${
              shared
                ? 'bg-sky-500/15 text-sky-400 hover:bg-sky-500/20'
                : 'bg-zinc-800/80 text-zinc-300 hover:bg-zinc-800 hover:text-white'
            }`}
          >
            <Share2 size={16} className={shared ? 'text-sky-400' : ''} />
            <span className="text-[11px]">{shares}</span>
          </button>
        </div>

        <button
          type="button"
          onClick={toggleBookmark}
          disabled={pending}
          className={`inline-flex items-center gap-1 rounded-full px-3 py-1.5 text-xs font-medium transition ${
            bookmarked
              ? 'bg-amber-500/15 text-amber-400 hover:bg-amber-500/20'
              : 'bg-zinc-800/80 text-zinc-400 hover:bg-zinc-800 hover:text-white'
          }`}
        >
          <Bookmark
            size={16}
            fill={bookmarked ? 'currentColor' : 'none'}
            className={bookmarked ? 'text-amber-400' : ''}
          />
          <span className="text-[11px]">{saves}</span>
        </button>
      </div>
      {!post.hide_likes && (
        <LikesListSheet
          postId={post.id}
          currentUserId={currentUserId}
          open={showLikesSheet}
          onClose={() => setShowLikesSheet(false)}
        />
      )}
    </div>
  );
}
