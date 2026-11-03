import React from 'react';

import UserIdentity from '../UserIdentity';
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
          className={`flex w-full items-center gap-4 rounded-xl px-2 py-1.5 text-right text-xs transition ${
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

          <UserIdentity
            name={person.full_name || person.username || 'مستخدم'}
            username={person.username}
            className="min-w-0 flex-1"
            nameClassName="font-bold text-white"
            usernameClassName="text-[10px] text-zinc-500"
          />
        </button>
      ))}
    </div>
  );
};

export default CommentMentionSuggestions;
