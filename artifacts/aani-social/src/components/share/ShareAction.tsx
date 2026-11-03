import { Loader2 } from 'lucide-react';
import type { ReactNode } from 'react';

const ShareAction = ({
  icon,
  label,
  onClick,
  tone = 'default',
  busy = false,
}: {
  icon: ReactNode;
  label: string;
  onClick: () => void;
  tone?: 'default' | 'active';
  busy?: boolean;
}) => (
  <button
    type="button"
    onClick={onClick}
    disabled={busy}
    className="flex w-[62px] shrink-0 flex-col items-center gap-1.5 disabled:opacity-60"
  >
    <span
      className={`flex h-11 w-11 items-center justify-center rounded-full border border-zinc-800 bg-zinc-900 transition active:scale-95 ${
        tone === 'active' ? 'text-[#E53E3E]' : 'text-zinc-200'
      }`}
    >
      {busy ? <Loader2 size={17} className="animate-spin" /> : icon}
    </span>
    <span className="w-full truncate text-center text-[10px] leading-4 text-zinc-400">
      {label}
    </span>
  </button>
);

export default ShareAction;
