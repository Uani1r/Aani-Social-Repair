import { Check } from 'lucide-react';

import EmptyState from '../EmptyState';
import { displayName, type Profile } from '../../lib/types';

const ShareRecipientList = ({
  users,
  loadingUsers,
  term,
  selected,
  onToggleSelect,
}: {
  users: Profile[];
  loadingUsers: boolean;
  term: string;
  selected: Set<string>;
  onToggleSelect: (userId: string) => void;
}) => (
  <div className="px-4 pt-1">
    <div className="flex items-center justify-between">
      <span className="text-[11px] font-bold text-zinc-400">الأصدقاء والمتابَعون</span>
      {selected.size > 0 && (
        <span className="text-[11px] font-bold text-pink-400">
          تم اختيار {selected.size}
        </span>
      )}
    </div>

    <div className="no-scrollbar mt-2 flex gap-3 overflow-x-auto pb-2">
      {loadingUsers ? (
        [0, 1, 2, 3, 4, 5].map(index => (
          <div key={index} className="flex w-[62px] shrink-0 flex-col items-center gap-1">
            <div className="h-14 w-14 animate-pulse rounded-full bg-zinc-800" />
            <div className="h-2 w-12 rounded bg-zinc-800" />
          </div>
        ))
      ) : users.length > 0 ? (
        users.map(user => (
          <button
            key={user.id}
            type="button"
            onClick={() => onToggleSelect(user.id)}
            aria-pressed={selected.has(user.id)}
            className="flex w-[62px] shrink-0 flex-col items-center gap-1"
          >
            <span className="relative">
              {user.avatar_url ? (
                <img
                  src={user.avatar_url}
                  alt=""
                  className={`h-14 w-14 rounded-full object-cover transition ${
                    selected.has(user.id) ? 'ring-2 ring-pink-500' : 'ring-1 ring-zinc-700'
                  }`}
                />
              ) : (
                <span
                  className={`flex h-14 w-14 items-center justify-center rounded-full bg-gradient-to-br from-pink-500 to-violet-600 text-sm font-bold text-white ${
                    selected.has(user.id) ? 'ring-2 ring-pink-500' : 'ring-1 ring-zinc-700'
                  }`}
                >
                  {displayName(user).charAt(0)}
                </span>
              )}
              {selected.has(user.id) && (
                <span className="absolute -bottom-0.5 -left-0.5 flex h-[18px] w-[18px] items-center justify-center rounded-full bg-pink-600 text-white ring-2 ring-zinc-950">
                  <Check size={10} />
                </span>
              )}
            </span>
            <span className="w-full truncate text-center text-[10px] leading-4 text-zinc-300">
              {displayName(user)}
            </span>
          </button>
        ))
      ) : (
        <EmptyState className="py-4" />
      )}
    </div>
  </div>
);

export default ShareRecipientList;
