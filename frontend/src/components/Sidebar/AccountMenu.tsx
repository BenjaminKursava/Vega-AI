import { useEffect, useRef, useState } from 'react';
import { Check, ChevronRight, LogIn, LogOut, Plus } from 'lucide-react';
import {
  getSessionToken,
  isGuest,
  listAccounts,
  signOut,
  switchAccount,
  type AuthUser,
  type StoredAccount,
} from '../../lib/auth';

interface AccountMenuProps {
  user: AuthUser;
  /** Switch the app to another already signed-in account. */
  onSwitch: (account: StoredAccount) => void;
  /** Show the sign-in screen so another account can be added. */
  onAddAccount: () => void;
  /** Last account signed out — the app should return to the auth screen. */
  onSignedOutCompletely: () => void;
}

/** "Appu k" -> "AK", "shithin@x.com" -> "S" */
function initials(user: AuthUser): string {
  const source = (user.display_name || '').trim();
  if (!source) return (user.email[0] || '?').toUpperCase();
  const parts = source.split(/\s+/).slice(0, 2);
  return parts.map((p) => p[0].toUpperCase()).join('');
}

function label(user: AuthUser): string {
  return user.display_name?.trim() || user.email;
}

export function AccountMenu({
  user,
  onSwitch,
  onAddAccount,
  onSignedOutCompletely,
}: AccountMenuProps) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);

  const activeToken = getSessionToken();
  const stored = listAccounts();
  // The current user always appears, even if the stored list does not
  // contain them — storage cleared, a session predating the account list,
  // or guest mode, which has no token at all. Otherwise the menu would
  // render with no accounts in it.
  const accounts: StoredAccount[] = stored.some((a) => a.token === activeToken)
    ? stored
    : [...stored, { token: activeToken, user }];

  const guest = isGuest(user);

  // Close on outside click or Escape.
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const handleSignOut = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const next = await signOut();
      setOpen(false);
      if (next) onSwitch(next);
      else onSignedOutCompletely();
    } finally {
      setBusy(false);
    }
  };

  const handleSwitch = (account: StoredAccount) => {
    if (account.token === activeToken) {
      setOpen(false);
      return;
    }
    switchAccount(account.token);
    setOpen(false);
    onSwitch(account);
  };

  return (
    <div ref={wrapRef} className="relative">
      {open && (
        <div
          role="menu"
          className="absolute bottom-full left-0 right-0 mb-1.5 overflow-hidden z-50"
          style={{
            background: 'var(--color-bg)',
            border: '1px solid var(--color-border)',
            borderRadius: 12,
            boxShadow: '0 16px 48px rgba(0,0,0,0.28)',
          }}
        >
          <div className="py-1">
            {accounts.map((account) => {
              const isActive = account.token === activeToken;
              return (
                <button
                  key={account.token}
                  role="menuitem"
                  onClick={() => handleSwitch(account)}
                  className="w-full flex items-center gap-2.5 px-3 py-2 text-left transition-colors cursor-pointer"
                  onMouseEnter={(e) => {
                    e.currentTarget.style.background = 'var(--color-bg-secondary)';
                  }}
                  onMouseLeave={(e) => {
                    e.currentTarget.style.background = 'transparent';
                  }}
                >
                  <Avatar user={account.user} muted={!isActive} />
                  <div className="flex-1 min-w-0">
                    <div
                      className="text-sm truncate"
                      style={{
                        color: 'var(--color-text)',
                        fontWeight: isActive ? 500 : 400,
                      }}
                    >
                      {label(account.user)}
                    </div>
                    <div
                      className="text-[11px] truncate"
                      style={{ color: 'var(--color-text-tertiary)' }}
                    >
                      {account.user.email ||
                        (isGuest(account.user) ? 'No account' : '')}
                    </div>
                  </div>
                  {isActive && (
                    <Check
                      size={15}
                      className="shrink-0"
                      style={{ color: 'var(--color-accent)' }}
                    />
                  )}
                </button>
              );
            })}
          </div>

          <div style={{ borderTop: '1px solid var(--color-border)' }} className="py-1">
            <MenuRow
              icon={guest ? LogIn : Plus}
              label={guest ? 'Sign in' : 'Add account'}
              onClick={() => {
                setOpen(false);
                onAddAccount();
              }}
            />
            <MenuRow
              icon={LogOut}
              label={
                busy
                  ? 'Signing out…'
                  : guest
                    ? 'Exit guest mode'
                    : 'Sign out'
              }
              onClick={handleSignOut}
            />
          </div>
        </div>
      )}

      <button
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
        className="w-full flex items-center gap-2.5 px-3 py-2 rounded-lg transition-colors cursor-pointer text-left"
        style={{ background: open ? 'var(--color-bg-secondary)' : 'transparent' }}
        onMouseEnter={(e) => {
          e.currentTarget.style.background = 'var(--color-bg-secondary)';
        }}
        onMouseLeave={(e) => {
          if (!open) e.currentTarget.style.background = 'transparent';
        }}
      >
        <Avatar user={user} />
        <div className="flex-1 min-w-0">
          <div
            className="text-sm truncate"
            style={{ color: 'var(--color-text)', fontWeight: 500 }}
          >
            {label(user)}
          </div>
          <div
            className="text-[11px] truncate"
            style={{ color: 'var(--color-text-tertiary)' }}
          >
            {guest ? 'Not signed in' : user.email || 'Signed in'}
          </div>
        </div>
        <ChevronRight
          size={14}
          className="shrink-0"
          style={{ color: 'var(--color-text-tertiary)' }}
        />
      </button>
    </div>
  );
}

function MenuRow({
  icon: Icon,
  label: text,
  onClick,
}: {
  icon: typeof Plus;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      role="menuitem"
      onClick={onClick}
      className="w-full flex items-center gap-2.5 px-3 py-2 text-sm text-left transition-colors cursor-pointer"
      style={{ color: 'var(--color-text-secondary)' }}
      onMouseEnter={(e) => {
        e.currentTarget.style.background = 'var(--color-bg-secondary)';
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.background = 'transparent';
      }}
    >
      <Icon size={15} className="shrink-0" style={{ color: 'var(--color-text-tertiary)' }} />
      {text}
    </button>
  );
}

function Avatar({ user, muted }: { user: AuthUser; muted?: boolean }) {
  return (
    <div
      className="flex items-center justify-center shrink-0 rounded-full text-[11px] font-semibold"
      style={{
        width: 26,
        height: 26,
        color: 'white',
        background: muted
          ? 'var(--color-text-tertiary)'
          : 'linear-gradient(135deg, var(--color-accent), var(--color-accent-purple))',
      }}
    >
      {initials(user)}
    </div>
  );
}
