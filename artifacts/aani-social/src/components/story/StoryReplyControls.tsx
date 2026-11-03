import { Eye, Heart, Loader2, SendHorizontal } from 'lucide-react';

import type { StoryViewerProps } from './types';

type StoryReplyControlsProps = Pick<
  StoryViewerProps,
  | 'currentStory'
  | 'showUI'
  | 'isStoryOwner'
  | 'replyKeyboardInset'
  | 'replyText'
  | 'isSendingReply'
  | 'isLiked'
  | 'isLikeSaving'
  | 'onOpenStoryViews'
  | 'onSendReply'
  | 'onReplyTextChange'
  | 'onReplyFocusChange'
  | 'onToggleLike'
>;

export default function StoryReplyControls({
  currentStory,
  showUI,
  isStoryOwner,
  replyKeyboardInset,
  replyText,
  isSendingReply,
  isLiked,
  isLikeSaving,
  onOpenStoryViews,
  onSendReply,
  onReplyTextChange,
  onReplyFocusChange,
  onToggleLike,
}: StoryReplyControlsProps) {
  return (
    <>
      {isStoryOwner && <div className="absolute inset-x-0 bottom-0 z-[25] h-24" aria-hidden="true" />}

      {showUI && isStoryOwner && (
        <button
          type="button"
          onClick={() => onOpenStoryViews()}
          aria-label="عرض مشاهدات الستوري"
          title="عرض المشاهدات"
          className="absolute left-1/2 z-30 flex h-10 w-10 -translate-x-1/2 items-center justify-center text-white drop-shadow-[0_1px_5px_rgba(0,0,0,0.9)]"
          style={{ bottom: 'calc(0.65rem + env(safe-area-inset-bottom))' }}
        >
          <Eye size={23} />
        </button>
      )}

      {showUI && !isStoryOwner && (
        <div
          className="absolute inset-x-0 bottom-0 z-30 flex items-center gap-2 bg-gradient-to-t from-black/95 via-black/75 to-transparent px-3 pt-5"
          style={{ paddingBottom: `calc(0.75rem + env(safe-area-inset-bottom) + ${replyKeyboardInset}px)` }}
          onClick={event => event.stopPropagation()}
        >
          <div className="flex min-w-0 flex-1 items-center rounded-full border border-zinc-700/70 bg-zinc-900/95 px-3 py-2 shadow-lg">
            <input
              key={currentStory.id}
              type="text"
              placeholder="رد على الستوري..."
              aria-label="اكتب رداً على الستوري"
              maxLength={3900}
              value={replyText}
              disabled={isSendingReply}
              onFocus={() => onReplyFocusChange(true)}
              onBlur={() => onReplyFocusChange(false)}
              onChange={event => onReplyTextChange(event.target.value)}
              onKeyDown={event => {
                if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
                  event.preventDefault();
                  onSendReply();
                }
              }}
              className="w-full min-w-0 bg-transparent text-xs text-white outline-none placeholder-zinc-400 disabled:opacity-60"
            />
            {replyText.trim() && (
              <button
                type="button"
                onClick={onSendReply}
                disabled={isSendingReply}
                aria-label="إرسال الرد"
                className="mr-1 flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-pink-400 transition hover:bg-white/10 disabled:opacity-50"
              >
                {isSendingReply ? <Loader2 size={16} className="animate-spin" /> : <SendHorizontal size={16} />}
              </button>
            )}
          </div>

          <button
            type="button"
            onClick={onToggleLike}
            disabled={isLikeSaving}
            aria-label={isLiked ? 'إلغاء الإعجاب بالستوري' : 'الإعجاب بالستوري'}
            aria-pressed={isLiked}
            className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-full border border-zinc-700/70 bg-zinc-900/90 transition disabled:opacity-50 ${isLiked ? 'text-pink-500' : 'text-white'}`}
          >
            {isLikeSaving ? <Loader2 size={17} className="animate-spin" /> : <Heart size={19} fill={isLiked ? 'currentColor' : 'none'} />}
          </button>
        </div>
      )}
    </>
  );
}
