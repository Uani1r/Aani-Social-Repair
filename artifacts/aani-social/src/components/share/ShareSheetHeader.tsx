import { Search, X } from 'lucide-react';

const ShareSheetHeader = ({
  onClose,
  searchOpen,
  onToggleSearch,
  term,
  onTermChange,
}: {
  onClose: () => void;
  searchOpen: boolean;
  onToggleSearch: () => void;
  term: string;
  onTermChange: (value: string) => void;
}) => (
  <>
    <div className="flex shrink-0 items-center justify-between px-4 pb-2">
      <button
        type="button"
        onClick={onClose}
        aria-label="إغلاق"
        className="rounded-full p-1.5 text-zinc-400 transition hover:bg-zinc-800 hover:text-white"
      >
        <X size={20} />
      </button>

      <h2 className="text-[15px] font-bold text-zinc-100">إرسال إلى</h2>

      <button
        type="button"
        onClick={onToggleSearch}
        aria-label="بحث"
        aria-pressed={searchOpen}
        className={`rounded-full p-1.5 transition hover:bg-zinc-800 ${
          searchOpen ? 'text-pink-400' : 'text-zinc-400 hover:text-white'
        }`}
      >
        <Search size={18} />
      </button>
    </div>

    {searchOpen && (
      <div className="shrink-0 px-4 pb-2">
        <div className="flex items-center gap-2 rounded-full border border-zinc-700/70 bg-zinc-900 px-3 py-2">
          <Search size={15} className="text-zinc-500" />
          <input
            autoFocus
            value={term}
            onChange={event => onTermChange(event.target.value)}
            placeholder="ابحث بالاسم أو اسم المستخدم..."
            className="flex-1 bg-transparent text-sm text-zinc-100 outline-none placeholder-zinc-500"
          />
          {term && (
            <button
              type="button"
              onClick={() => onTermChange('')}
              aria-label="مسح البحث"
              className="text-zinc-500 transition hover:text-white"
            >
              <X size={14} />
            </button>
          )}
        </div>
      </div>
    )}
  </>
);

export default ShareSheetHeader;
