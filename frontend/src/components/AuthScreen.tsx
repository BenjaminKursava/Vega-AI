import { useState } from 'react';
import { Lock, Mail, User, ShieldCheck, HardDrive } from 'lucide-react';
import { signIn, signUp, type AuthUser } from '../lib/auth';

interface AuthScreenProps {
  /** False on first run — no account exists yet, so open on Sign Up. */
  hasAccount: boolean;
  onAuthenticated: (user: AuthUser) => void;
  /** True when adding a SECOND account from the account menu. */
  addingAccount?: boolean;
  /** Provided only when the screen can be dismissed (adding an account). */
  onCancel?: () => void;
  /** Enter the app with no account at all. Hidden while adding an account. */
  onContinueAsGuest?: () => void;
}

const MIN_PASSWORD_LENGTH = 8; // matches auth_store.MIN_PASSWORD_LENGTH

export function AuthScreen({
  hasAccount,
  onAuthenticated,
  addingAccount = false,
  onCancel,
  onContinueAsGuest,
}: AuthScreenProps) {
  const [mode, setMode] = useState<'signin' | 'signup'>(
    hasAccount ? 'signin' : 'signup',
  );
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const isSignUp = mode === 'signup';

  const submit = async () => {
    const trimmedEmail = email.trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmedEmail)) {
      setError('Please enter a valid email address.');
      return;
    }
    if (isSignUp && password.length < MIN_PASSWORD_LENGTH) {
      setError(`Password must be at least ${MIN_PASSWORD_LENGTH} characters.`);
      return;
    }
    if (!password) {
      setError('Please enter your password.');
      return;
    }

    setError('');
    setBusy(true);
    try {
      const user = isSignUp
        ? await signUp(trimmedEmail, password, displayName.trim())
        : await signIn(trimmedEmail, password);
      setPassword('');
      onAuthenticated(user);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong.');
    } finally {
      setBusy(false);
    }
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !busy) submit();
  };

  const switchMode = () => {
    setMode(isSignUp ? 'signin' : 'signup');
    setError('');
    setPassword('');
  };

  return (
    <div
      className="fixed inset-0 flex items-center justify-center p-4"
      style={{ background: 'var(--color-bg)' }}
    >
      <div
        className="w-full max-w-md"
        style={{
          background: 'var(--color-bg)',
          borderRadius: 16,
          border: '1px solid var(--color-border)',
          boxShadow: '0 24px 80px rgba(0,0,0,0.25)',
        }}
      >
        <div className="px-8 pt-8 pb-7">
          <div
            className="flex items-center justify-center w-14 h-14 rounded-2xl mb-5 mx-auto"
            style={{
              background:
                'linear-gradient(135deg, var(--color-accent), var(--color-accent-purple))',
            }}
          >
            <ShieldCheck size={28} color="white" />
          </div>

          <h1
            className="text-xl font-semibold text-center mb-1.5"
            style={{ color: 'var(--color-text)' }}
          >
            {addingAccount
              ? 'Add another account'
              : isSignUp
                ? 'Create your account'
                : 'Welcome back'}
          </h1>
          <p
            className="text-sm text-center mb-6 leading-relaxed"
            style={{ color: 'var(--color-text-secondary)' }}
          >
            {addingAccount
              ? 'Sign in as someone else. Your current account stays signed in — switch between them from the account menu.'
              : isSignUp
                ? 'Set up the account that unlocks Vega on this computer.'
                : 'Sign in to unlock Vega.'}
          </p>

          {isSignUp && (
            <Field label="Name" optional>
              <IconInput icon={User}>
                <input
                  type="text"
                  value={displayName}
                  onChange={(e) => setDisplayName(e.target.value)}
                  onKeyDown={onKeyDown}
                  placeholder="What should Vega call you?"
                  maxLength={60}
                  style={inputStyle}
                  className="w-full bg-transparent outline-none text-sm"
                  autoFocus
                />
              </IconInput>
            </Field>
          )}

          <Field label="Email">
            <IconInput icon={Mail}>
              <input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                onKeyDown={onKeyDown}
                placeholder="you@example.com"
                autoComplete="username"
                style={inputStyle}
                className="w-full bg-transparent outline-none text-sm"
                autoFocus={!isSignUp}
              />
            </IconInput>
          </Field>

          <Field
            label="Password"
            hint={isSignUp ? `At least ${MIN_PASSWORD_LENGTH} characters` : undefined}
          >
            <IconInput icon={Lock}>
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                onKeyDown={onKeyDown}
                placeholder={isSignUp ? 'Choose a password' : 'Your password'}
                autoComplete={isSignUp ? 'new-password' : 'current-password'}
                style={inputStyle}
                className="w-full bg-transparent outline-none text-sm"
              />
            </IconInput>
          </Field>

          {error && (
            <p className="text-xs mb-3" style={{ color: 'var(--color-error)' }}>
              {error}
            </p>
          )}

          <button
            onClick={submit}
            disabled={busy}
            className="w-full py-2.5 rounded-xl text-sm font-medium transition-all cursor-pointer"
            style={{
              background: 'var(--color-accent)',
              color: 'var(--color-on-accent)',
              opacity: busy ? 0.6 : 1,
            }}
          >
            {busy
              ? 'Please wait…'
              : isSignUp
                ? 'Create account'
                : 'Sign in'}
          </button>

          <button
            onClick={switchMode}
            className="w-full py-2 text-sm transition-colors cursor-pointer mt-2"
            style={{ color: 'var(--color-text-tertiary)' }}
          >
            {isSignUp
              ? 'Already have an account? Sign in'
              : addingAccount
                ? 'Create a new account instead'
                : 'Need an account? Sign up'}
          </button>

          {onCancel && (
            <button
              onClick={onCancel}
              className="w-full py-2 text-sm transition-colors cursor-pointer"
              style={{ color: 'var(--color-text-tertiary)' }}
            >
              Cancel
            </button>
          )}

          {onContinueAsGuest && !addingAccount && (
            <div
              className="mt-4 pt-4"
              style={{ borderTop: '1px solid var(--color-border)' }}
            >
              <button
                onClick={onContinueAsGuest}
                className="w-full py-2.5 rounded-xl text-sm font-medium transition-all cursor-pointer"
                style={{
                  background: 'var(--color-bg-secondary)',
                  border: '1px solid var(--color-border)',
                  color: 'var(--color-text-secondary)',
                }}
              >
                No thanks
              </button>
              <p
                className="text-[11px] text-center mt-1.5 leading-snug"
                style={{ color: 'var(--color-text-tertiary)' }}
              >
                Use Vega without an account. You can sign in later from the
                account menu.
              </p>
            </div>
          )}

          <div
            className="flex items-start gap-2 mt-5 pt-4"
            style={{ borderTop: '1px solid var(--color-border)' }}
          >
            <HardDrive
              size={13}
              className="shrink-0 mt-0.5"
              style={{ color: 'var(--color-text-tertiary)' }}
            />
            <p
              className="text-[11px] leading-snug"
              style={{ color: 'var(--color-text-tertiary)' }}
            >
              This account is stored only on this computer, in
              <code className="mx-1">~/.openjarvis/users.db</code>. Your email
              and password are never sent anywhere else.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}

const inputStyle: React.CSSProperties = { color: 'var(--color-text)' };

function Field({
  label,
  hint,
  optional,
  children,
}: {
  label: string;
  hint?: string;
  optional?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div className="mb-3">
      <label
        className="block text-xs font-medium mb-1.5"
        style={{ color: 'var(--color-text-secondary)' }}
      >
        {label}
        {optional && (
          <span
            className="font-normal ml-1"
            style={{ color: 'var(--color-text-tertiary)' }}
          >
            (optional)
          </span>
        )}
        {hint && (
          <span
            className="font-normal ml-1"
            style={{ color: 'var(--color-text-tertiary)' }}
          >
            — {hint}
          </span>
        )}
      </label>
      {children}
    </div>
  );
}

function IconInput({
  icon: Icon,
  children,
}: {
  icon: typeof Mail;
  children: React.ReactNode;
}) {
  return (
    <div
      className="flex items-center gap-2 px-3 py-2.5 rounded-xl"
      style={{
        background: 'var(--color-bg-secondary)',
        border: '1.5px solid var(--color-border)',
      }}
    >
      <Icon
        size={14}
        className="shrink-0"
        style={{ color: 'var(--color-text-tertiary)' }}
      />
      {children}
    </div>
  );
}
