import React from 'react';
import { AtSign, Send, Sticker, X } from 'lucide-react';

import type { CommentWithDetails } from '../../lib/interactions';
import type { MentionQuery } from '../../lib/mentions';
import type { CommentComposerProfile, MentionCandidate } from './types';
import { buildInitials } from './utils';
import CommentMediaPicker from './CommentMediaPicker';
import CommentMediaPreview from './CommentMediaPreview';
import CommentMentionSuggestions from './CommentMentionSuggestions';

interface CommentComposerProps {
  content: string;
  replyingTo: CommentWithDetails | null;
  currentUser: CommentComposerProfile;
  selectedImage: File | null;
  previewUrl: string | null;
  submitting: boolean;
  showStickerPicker: boolean;
  mentionQuery: MentionQuery | null;
  mentionSuggestions: MentionCandidate[];
  mentionIndex: number;
  textareaRef: React.RefObject<HTMLTextAreaElement | null>;
  onSubmit: React.FormEventHandler<HTMLFormElement>;
  onContentChange: React.ChangeEventHandler<HTMLTextAreaElement>;
  onKeyDown: React.KeyboardEventHandler<HTMLTextAreaElement>;
  onCancelReply: () => void;
  onRemoveImage: () => void;
  onMentionSelect: (person: MentionCandidate) => void;
  onInsertMention: () => void;
  onToggleStickerPicker: () => void;
  onInsertSticker: (sticker: string) => void;
  onSelectImage: (file: File) => void;
}

const stickers = ['❤️', '🥰', '😂', '👏', '🙏', '✨', '🌷', '🤍', '🫶', '🎉'];

const CommentComposer: React.FC<CommentComposerProps> = ({
  content,
  replyingTo,
  currentUser,
  selectedImage,
  previewUrl,
  submitting,
  showStickerPicker,
  mentionQuery,
  mentionSuggestions,
  mentionIndex,
  textareaRef,
  onSubmit,
  onContentChange,
  onKeyDown,
  onCancelReply,
  onRemoveImage,
  onMentionSelect,
  onInsertMention,
  onToggleStickerPicker,
  onInsertSticker,
  onSelectImage,
}) => (
  <footer
    className="comments-composer-footer shrink-0 space-y-2"
    style={{
      paddingBottom: 'max(0.75rem, env(safe-area-inset-bottom))',
    }}
  >
    {replyingTo && (
      <div className="flex items-center justify-between rounded-xl border border-zinc-800 bg-zinc-900 px-3 py-1.5 text-xs text-zinc-300">
        <span>
          الرد على{' '}
          <strong className="text-pink-400">
            {replyingTo.profiles?.full_name || replyingTo.profiles?.username || 'مستخدم'}
          </strong>
        </span>

        <button
          type="button"
          onClick={onCancelReply}
          className="text-zinc-400 hover:text-white"
          aria-label="إلغاء الرد"
        >
          <X size={14} />
        </button>
      </div>
    )}

    {previewUrl && (
      <CommentMediaPreview previewUrl={previewUrl} onRemove={onRemoveImage} />
    )}

    <form className="flex items-center gap-2.5" onSubmit={onSubmit}>
      <div className="shrink-0">
        {currentUser?.avatar_url ? (
          <img
            src={currentUser.avatar_url}
            alt={currentUser.full_name}
            className="h-11 w-11 rounded-full object-cover ring-1 ring-zinc-700"
          />
        ) : (
          <div className="flex h-11 w-11 items-center justify-center rounded-full bg-gradient-to-br from-pink-500 to-violet-600 text-sm font-bold text-white ring-1 ring-zinc-700">
            {buildInitials(currentUser?.full_name)}
          </div>
        )}
      </div>

      <div className="comments-composer-pill relative flex min-w-0 flex-1 items-center px-3 py-2.5">
        {mentionQuery && mentionSuggestions.length > 0 && (
          <CommentMentionSuggestions
            suggestions={mentionSuggestions}
            selectedIndex={mentionIndex}
            onSelect={onMentionSelect}
          />
        )}

        {showStickerPicker && (
          <div
            className="absolute bottom-full left-0 z-20 mb-3 grid grid-cols-5 gap-1 rounded-2xl border border-zinc-700 bg-zinc-900 p-2 shadow-xl"
            role="group"
            aria-label="اختيار ملصق"
          >
            {stickers.map((sticker) => (
              <button
                key={sticker}
                type="button"
                onClick={() => onInsertSticker(sticker)}
                className="flex h-9 w-9 items-center justify-center rounded-lg text-xl hover:bg-zinc-800"
                aria-label={`إضافة ${sticker}`}
              >
                {sticker}
              </button>
            ))}
          </div>
        )}

        <textarea
          ref={textareaRef}
          rows={1}
          value={content}
          onChange={onContentChange}
          onKeyDown={onKeyDown}
          placeholder={replyingTo ? 'اكتب رداً...' : 'إضافة تعليق...'}
          maxLength={2000}
          className="max-h-32 min-h-7 flex-1 resize-none bg-transparent px-1 text-right text-sm leading-7 text-zinc-100 placeholder-zinc-400 focus:outline-none"
          dir="rtl"
          aria-label={replyingTo ? 'اكتب رداً' : 'إضافة تعليق'}
        />

        <div className="mr-1 flex shrink-0 items-center gap-2 text-zinc-300">
          <button
            type="button"
            onClick={onInsertMention}
            className="rounded-full p-1.5 transition hover:bg-zinc-700 hover:text-white"
            title="إشارة @"
            aria-label="إضافة إشارة"
          >
            <AtSign size={22} strokeWidth={2.4} />
          </button>

          <button
            type="button"
            onClick={onToggleStickerPicker}
            className="rounded-full p-1.5 transition hover:bg-zinc-700 hover:text-white"
            title="ملصقات"
            aria-label="اختيار ملصق"
            aria-expanded={showStickerPicker}
          >
            <Sticker size={22} strokeWidth={2.3} />
          </button>

          <CommentMediaPicker onSelectImage={onSelectImage} />

          {(content.trim() || selectedImage) && (
            <button
              type="submit"
              disabled={submitting}
              className="rounded-full bg-pink-600 p-2 text-white transition hover:bg-pink-500 disabled:cursor-wait disabled:opacity-50"
              aria-label="نشر التعليق"
            >
              <Send size={18} className="rotate-180" />
            </button>
          )}
        </div>
      </div>
    </form>
  </footer>
);

export default CommentComposer;
