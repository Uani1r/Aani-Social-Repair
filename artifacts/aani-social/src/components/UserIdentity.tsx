import type { ReactNode } from 'react';

interface UserIdentityProps {
  name: ReactNode;
  username?: string | null;
  className?: string;
  nameClassName?: string;
  usernameClassName?: string;
}

export default function UserIdentity({
  name,
  username,
  className = '',
  nameClassName = 'text-sm font-bold text-white',
  usernameClassName = 'text-xs text-zinc-400',
}: UserIdentityProps) {
  return (
    <div className={`user-identity-meta ${className}`} dir="rtl">
      <div className={`min-w-0 truncate text-right leading-tight ${nameClassName}`}>
        {name}
      </div>
      {username && (
        <div className={`min-w-0 truncate text-right leading-tight ${usernameClassName}`} dir="ltr">
          {username}
        </div>
      )}
    </div>
  );
}
