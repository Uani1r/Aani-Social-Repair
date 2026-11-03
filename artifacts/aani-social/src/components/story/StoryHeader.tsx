import { Link } from 'wouter';
import { MoreVertical, Trash2, X } from 'lucide-react';

import Avatar from '@/components/Avatar';
import { displayName, formatDate } from '@/lib/types';

import type { StoryViewerProps } from './types';

type StoryHeaderProps = Pick<
  StoryViewerProps,
  | 'currentStory'
  | 'originalStoryAuthor'
  | 'userId'
  | 'showUI'
  | 'showMenu'
  | 'onMenuChange'
  | 'onReportStory'
  | 'onDeleteStory'
  | 'onCloseViewer'
>;

export default function StoryHeader({
  currentStory,
  originalStoryAuthor,
  userId,
  showUI,
  showMenu,
  onMenuChange,
  onReportStory,
  onDeleteStory,
  onCloseViewer,
}: StoryHeaderProps) {
  return (
    <>
      {showUI && (
        <div className="absolute inset-x-0 z-30 flex items-center justify-between px-3 pt-2 text-white bg-gradient-to-b from-black/80 via-black/40 to-transparent" style={{ top: 'calc(1.5rem + env(safe-area-inset-top))' }}>
          <div className="flex min-w-0 flex-col items-start gap-1">
            <Link href={`/profile/${currentStory.user_id}`} className="flex min-w-0 items-center gap-2">
              <Avatar profile={currentStory.author} storyBorder={false} />
              <div className="user-identity-meta h-8 min-w-0 flex-1">
                <div className="flex min-w-0 items-center gap-1">
                  <span className="truncate font-bold text-xs">{displayName(currentStory.author)}</span>
                  {currentStory.is_close_friends && (
                    <span className="shrink-0 rounded-md bg-emerald-500 px-1.5 py-0.5 text-[9px] font-semibold">أصدقاء مقربون</span>
                  )}
                </div>
                <div className="flex min-w-0 items-center justify-between gap-2">
                  <span className="truncate text-[10px] text-zinc-300" dir="ltr">{currentStory.author?.username}</span>
                  <span className="shrink-0 text-[10px] text-zinc-300">{formatDate(currentStory.created_at)}</span>
                </div>
              </div>
            </Link>
            {currentStory.original_story_id && originalStoryAuthor && (
              <div className="flex items-center gap-1 rounded-full bg-black/45 px-1.5 py-0.5 text-white/85 backdrop-blur-sm">
                {originalStoryAuthor.avatar_url ? (
                  <img src={originalStoryAuthor.avatar_url} alt="" className="h-4 w-4 rounded-full object-cover" />
                ) : (
                  <span className="flex h-4 w-4 items-center justify-center rounded-full bg-white/20 text-[7px] font-bold">
                    {displayName(originalStoryAuthor).replace('@', '').charAt(0)}
                  </span>
                )}
                <span className="max-w-[42vw] truncate text-[9px]">من قصة {displayName(originalStoryAuthor)}</span>
              </div>
            )}
          </div>

          <div className="flex items-center gap-2">
            <button
              type="button"
              data-story-viewer-menu-toggle="true"
              aria-label="خيارات الستوري"
              onClick={() => onMenuChange(!showMenu)}
              className="p-1 hover:bg-white/20 rounded-full"
            >
              <MoreVertical size={18} />
            </button>
            <button onClick={onCloseViewer} className="p-1 hover:bg-white/20 rounded-full">
              <X size={20} />
            </button>
          </div>
        </div>
      )}

      {showMenu && (
        <div data-story-viewer-menu="true" className="absolute top-14 left-3 z-40 bg-zinc-900 border border-zinc-800 rounded-xl p-2 shadow-xl text-xs space-y-1">
          {currentStory.user_id === userId ? (
            <button onClick={onDeleteStory} className="flex items-center gap-2 text-red-400 p-2 w-full hover:bg-zinc-800 rounded-lg">
              <Trash2 size={14} /> حذف الستوري
            </button>
          ) : (
            <button onClick={onReportStory} className="p-2 w-full text-zinc-300 hover:bg-zinc-800 rounded-lg">
              إبلاغ عن الستوري
            </button>
          )}
        </div>
      )}
    </>
  );
}
