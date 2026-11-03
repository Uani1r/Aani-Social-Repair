import { Loader2, Send } from 'lucide-react';

const ShareComposerFooter = ({
  note,
  selectedCount,
  sending,
  onNoteChange,
  onSend,
}: {
  note: string;
  selectedCount: number;
  sending: boolean;
  onNoteChange: (value: string) => void;
  onSend: () => void;
}) => (
  <div
    className="shrink-0 border-t border-zinc-800/80 bg-zinc-950 px-3 py-2.5"
    style={{ paddingBottom: 'max(0.625rem, env(safe-area-inset-bottom))' }}
  >
    <div className="flex items-center gap-2">
      <input
        value={note}
        onChange={event => onNoteChange(event.target.value.slice(0, 300))}
        placeholder="أضف رسالة (اختياري)"
        className="min-w-0 flex-1 rounded-full border border-zinc-800 bg-zinc-900 px-3.5 py-2.5 text-xs text-zinc-100 outline-none placeholder-zinc-500 focus:border-pink-500/60"
      />
      {selectedCount > 0 ? (
        <button
          type="button"
          onClick={onSend}
          disabled={sending}
          className="flex shrink-0 items-center gap-1.5 rounded-full bg-pink-600 px-5 py-2.5 text-xs font-bold text-white transition hover:bg-pink-500 disabled:opacity-50"
        >
          {sending ? (
            <Loader2 size={14} className="animate-spin" />
          ) : (
            <Send size={14} className="rotate-180" />
          )}
          إرسال ({selectedCount})
        </button>
      ) : (
        <span className="shrink-0 px-2 text-[10px] text-zinc-500">اختر شخصاً</span>
      )}
    </div>
  </div>
);

export default ShareComposerFooter;
