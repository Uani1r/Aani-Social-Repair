import { Plus, Star } from 'lucide-react';

import Avatar from '../Avatar';
import UserIdentity from '../UserIdentity';
import type { Profile } from '@/lib/types';
import type { StoriesByUser, StoryRow } from './types';

interface StoriesStripProps {
  userId: string;
  currentProfile: Profile | null;
  groupedStories: StoriesByUser;
  seenStoryIds: string[];
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
    <div className="story-bar story-strip mb-2 w-full">
      <div className="story-bar-content flex w-full items-center gap-[18px] overflow-x-auto no-scrollbar px-1 pb-1 pt-1">
        {/* قصتك */}
        <div className="flex flex-col items-center gap-1 shrink-0">
          <div
            className={`relative flex h-16 w-16 cursor-pointer items-center justify-center rounded-full ${hasMyStory ? 'p-[2.5px]' : 'border-[1.5px] border-dashed border-zinc-600/70 p-[2px]'}`}
            style={hasMyStory ? {
              background: hasSeenAllMyStories
                ? '#3a3a42'
                : 'conic-gradient(from 0deg, #FF0055, #ff6b8a, #FF0055)',
            } : undefined}
            onClick={() => {
              if (uploading) return;
              if (hasMyStory) onOpenMyStories();
              else onOpenPicker();
            }}
          >
            {hasMyStory || uploading ? (
              <span className="flex h-full w-full items-center justify-center overflow-hidden rounded-full border-[3px] border-[#121212] bg-zinc-900">
                <Avatar profile={currentProfile} extraLarge />
              </span>
            ) : (
              <span className="text-2xl font-light text-zinc-500">+</span>
            )}
            {uploading && (
              <svg
                viewBox="0 0 64 64"
                className="pointer-events-none absolute z-10 h-16 w-16 animate-spin"
                style={{ left: 'calc(50% - 2rem)', top: 'calc(50% - 2rem)' }}
                role="progressbar"
                aria-label={`جارٍ نشر القصة ${uploadProgress}%`}
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={uploadProgress}
              >
                <circle cx="32" cy="32" r="29" fill="none" stroke="rgba(255,255,255,0.22)" strokeWidth="2.5" />
                <circle
                  cx="32"
                  cy="32"
                  r="29"
                  fill="none"
                  stroke="#ec4899"
                  strokeWidth="2.5"
                  strokeLinecap="round"
                  strokeDasharray={2 * Math.PI * 29}
                  strokeDashoffset={2 * Math.PI * 29 * (1 - uploadProgress / 100)}
                  style={{ transition: 'stroke-dashoffset 120ms linear' }}
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
              className="absolute -bottom-0.5 -right-0.5 z-20 flex h-5 w-5 items-center justify-center rounded-full border border-zinc-700 bg-zinc-900 text-zinc-300 disabled:opacity-50"
              title="إضافة ستوري جديدة"
            >
              <Plus size={12} />
            </button>
          </div>
          <span className="text-[11.5px] text-zinc-400 truncate w-16 text-center">قصتك</span>
        </div>

        {/* قصص المتابَعين بحلقة العلم العراقي */}
        {Object.keys(groupedStories).filter(id => id !== userId).map(authorId => {
          const firstStory = groupedStories[authorId][0];
          const isSeen = hasSeenAllStories(groupedStories[authorId]);
          const hasCloseFriendsStory = groupedStories[authorId].some(story => story.is_close_friends);

          return (
            <div
              key={authorId}
              className="flex flex-col items-center gap-1 cursor-pointer shrink-0"
              onClick={() => onOpenStoryGroup(authorId)}
            >
              <span
                className="relative flex h-16 w-16 items-center justify-center rounded-full p-[2.5px] transition-colors duration-200"
                style={{
                  background: isSeen
                    ? '#3a3a42'
                    : 'conic-gradient(from 0deg, #FF0055, #ff6b8a, #FF0055)',
                }}
              >
                <span className="flex h-full w-full items-center justify-center overflow-hidden rounded-full border-[3px] border-[#121212] bg-zinc-900">
                  <Avatar profile={firstStory.author} extraLarge />
                </span>
                {hasCloseFriendsStory && (
                  <span className="absolute -bottom-0.5 -left-0.5 flex h-5 w-5 items-center justify-center rounded-full border border-[#121212] bg-emerald-500 text-white" title="أصدقاء مقربون">
                    <Star size={10} fill="currentColor" />
                  </span>
                )}
              </span>
              <UserIdentity
                name={firstStory.author?.full_name || firstStory.author?.username || 'عضو'}
                username={firstStory.author?.full_name ? firstStory.author.username : null}
                className="w-16"
                nameClassName="text-[10px] text-zinc-400"
                usernameClassName="text-[9px] text-zinc-500"
              />
            </div>
          );
        })}
      </div>
    </div>
  );
}
