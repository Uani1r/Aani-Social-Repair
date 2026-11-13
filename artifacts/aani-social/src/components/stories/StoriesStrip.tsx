import { Plus, Star } from 'lucide-react';

import Avatar from '../Avatar';
import UserIdentity from '../UserIdentity';
import { displayName } from '@/lib/types';
import type { Profile } from '@/lib/types';
import type { StoriesByUser, StoryRow } from './types';

interface StoriesStripProps {
  userId: string;
  currentProfile: Profile | null;
  groupedStories: StoriesByUser;
  seenStoryIds: string[];
  orderedUserIds: string[];
  uploading: boolean;
  uploadProgress: number;
  onOpenMyStories: () => void;
  onOpenPicker: () => void;
  onOpenStoryGroup: (userId: string) => void;
}

export default function StoriesStrip({
  userId,
  currentProfile,
  groupedStories,
  seenStoryIds,
  orderedUserIds,
  uploading,
  uploadProgress,
  onOpenMyStories,
  onOpenPicker,
  onOpenStoryGroup,
}: StoriesStripProps) {
  const myStories = groupedStories[userId] || [];
  const hasMyStory = myStories.length > 0;
  const myStoryHasCloseFriends = myStories.some(story => story.is_close_friends);
  const hasSeenAllStories = (stories: StoryRow[]) =>
    stories.length > 0 && stories.every(story => seenStoryIds.includes(story.id));
  const hasSeenAllMyStories = hasSeenAllStories(myStories);

  return (
    <div className="story-bar story-strip unified-story-strip w-full">
      <div className="story-bar-content unified-stories-content flex w-full items-center overflow-x-auto no-scrollbar">
        {/* قصتك */}
        <div className="unified-story-item">
          <div
            className={`unified-story-ring ${hasMyStory ? (hasSeenAllMyStories ? 'is-seen' : 'is-unseen') : 'is-own-story'}`}
            onClick={() => {
              if (uploading) return;
              if (hasMyStory) onOpenMyStories();
              else onOpenPicker();
            }}
          >
            <span className="unified-story-avatar flex h-full w-full items-center justify-center overflow-hidden rounded-full">
              {currentProfile?.avatar_url ? (
                <img
                  src={currentProfile.avatar_url}
                  alt=""
                  className="h-full w-full rounded-full object-cover"
                />
              ) : (
                <span className="unified-story-avatar-fallback">
                  {displayName(currentProfile).slice(0, 1) || 'آ'}
                </span>
              )}
            </span>
            {uploading && (
              <svg
                viewBox="0 0 80 80"
                className="unified-story-upload-ring"
                role="progressbar"
                aria-label={`جارٍ نشر القصة ${uploadProgress}%`}
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={uploadProgress}
              >
                {/* الحلقة على الإطار الخارجي (نصف قطر أكبر من إطار الصورة) فلا تلامس الصورة */}
                <circle cx="40" cy="40" r="37" fill="none" stroke="rgba(255,255,255,0.22)" strokeWidth="2.5" />
                <circle
                  cx="40"
                  cy="40"
                  r="37"
                  fill="none"
                  stroke="#ec4899"
                  strokeWidth="2.5"
                  strokeLinecap="round"
                  strokeDasharray={2 * Math.PI * 37}
                  strokeDashoffset={2 * Math.PI * 37 * (1 - Math.max(0, Math.min(100, uploadProgress)) / 100)}
                />
              </svg>
            )}
            {hasMyStory && myStoryHasCloseFriends && (
              <span
                className="absolute -bottom-0.5 -left-0.5 z-20 flex h-5 w-5 items-center justify-center rounded-full border border-[#121212] bg-emerald-500 text-white"
                title="أصدقاء مقربون"
              >
                <Star size={10} fill="currentColor" />
              </span>
            )}
            <button
              type="button"
              disabled={uploading}
              onClick={event => {
                event.stopPropagation();
                if (!uploading) onOpenPicker();
              }}
              className="unified-story-badge absolute -bottom-0.5 -right-0.5 z-20 flex h-5 w-5 items-center justify-center rounded-full disabled:opacity-50"
              title="إضافة ستوري جديدة"
            >
              <Plus size={12} />
            </button>
          </div>
          <span className="unified-story-label">قصتك</span>
        </div>

        {/* قصص المتابَعين */}
        {orderedUserIds.filter(id => id !== userId && groupedStories[id]?.length).map(authorId => {
          const firstStory = groupedStories[authorId][0];
          const isSeen = hasSeenAllStories(groupedStories[authorId]);
          const hasCloseFriendsStory = groupedStories[authorId].some(story => story.is_close_friends);

          return (
            <div
              key={authorId}
              className="unified-story-item"
              onClick={() => onOpenStoryGroup(authorId)}
            >
              <span
                className={`unified-story-ring ${isSeen ? 'is-seen' : 'is-unseen'}`}
              >
                <span className="unified-story-avatar flex h-full w-full items-center justify-center overflow-hidden rounded-full">
                  <Avatar profile={firstStory.author} extraLarge />
                </span>
                {hasCloseFriendsStory && (
                  <span className="absolute -bottom-0.5 -left-0.5 flex h-5 w-5 items-center justify-center rounded-full border border-[#121212] bg-emerald-500 text-white" title="أصدقاء مقربون">
                    <Star size={10} fill="currentColor" />
                  </span>
                )}
              </span>
              <UserIdentity
                name={displayName(firstStory.author)}
                username={firstStory.author?.username}
                className="unified-story-identity"
                nameClassName="unified-story-name"
                usernameClassName="unified-story-username"
              />
            </div>
          );
        })}
      </div>
    </div>
  );
}
