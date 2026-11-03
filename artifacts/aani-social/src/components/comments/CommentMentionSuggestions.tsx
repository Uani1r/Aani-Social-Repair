import React from 'react';

import type { MentionCandidate } from './types';
import { buildInitials } from './utils';

interface CommentMentionSuggestionsProps {
  suggestions: MentionCandidate[];
  selectedIndex: number;
  onSelect: (person: MentionCandidate) => void;
}

const CommentMentionSuggestions: React.FC<CommentMentionSuggestionsProps> = ({
  suggestions,
  selectedIndex,
  onSelect,
}) => {
  if (suggestions.length === 0) return null;

  return (
    <div
      className="absolute bottom-full right-0 z-30 mb-3 max-h-64 w-64 max-w-[82vw] overflow-y-auto rounded-2xl border border-zinc-700 bg-zinc-900 p-1 shadow-xl"
      role="listbox"
      aria-label="اقتراحات المنشن"
    >
      {suggestions.map((person, index) => (
        <button
          key={person.id}
          type="button"
          role="option"
          aria-selected={index === selectedIndex}
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => onSelect(person)}
          className={`flex w-full items-center gap-2 rounded-xl px-2 py-1.5 text-right text-xs transition ${
            index === selectedIndex ? 'bg-zinc-800' : 'hover:bg-zinc-800/70'
          }`}
        >
          {person.avatar_url ? (
            <img
              src={person.avatar_url}
              alt=""
              className="h-7 w-7 shrink-0 rounded-full object-cover"
            />
          ) : (
            <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-pink-500 to-violet-600 text-[10px] font-bold text-white">
              {buildInitials(person.full_name)}
            </span>
          )}

          <span className="user-identity-meta h-7 min-w-0 flex-1">
            <strong className="block truncate leading-tight text-white">
              {person.full_name || person.username || 'مستخدم'}
            </strong>
            {person.username && (
              <span className="block truncate text-[10px] leading-none text-zinc-500" dir="ltr">
                {person.username}
              </span>
            )}
          </span>
        </button>
      ))}
    </div>
  );
};

export default CommentMentionSuggestions;
