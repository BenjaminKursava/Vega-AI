/**
 * Local account client.
 *
 * Talks only to this machine's own Jarvis server (`/v1/auth/*`), which
 * stores accounts in ~/.openjarvis/users.db. No third party is involved:
 * there is no Supabase call, no analytics, and no email ever leaves the
 * box. The password is sent to the local server once per sign-in and is
 * never written to localStorage — only the opaque session token is.
 */

import { getBase } from './api';

/** Token of the account currently in use. */
const SESSION_KEY = 'openjarvis-session';
/** Every account signed in on this browser, so you can switch between them. */
const ACCOUNTS_KEY = 'openjarvis-accounts';
/** Set when the user chose "No thanks" and is using Jarvis without an account. */
const GUEST_KEY = 'openjarvis-guest';

/** Matches SESSION_HEADER in server/auth_routes.py. */
export const SESSION_HEADER = 'X-OJ-Session';

export interface AuthUser {
  id: number;
  email: string;
  display_name: string;
  created_at: number;
}

export interface AuthStatus {
  has_account: boolean;
  signed_in: boolean;
  user: AuthUser | null;
}

/** One signed-in account: its session token plus the user it belongs to. */
export interface StoredAccount {
  token: string;
  user: AuthUser;
}

export function getSessionToken(): string {
  try {
    return localStorage.getItem(SESSION_KEY) || '';
  } catch {
    return '';
  }
}

function storeSessionToken(token: string): void {
  try {
    localStorage.setItem(SESSION_KEY, token);
  } catch {
    // Private-mode browsers can refuse writes; the session then lasts
    // for this tab only, which is acceptable.
  }
}

export function clearSessionToken(): void {
  try {
    localStorage.removeItem(SESSION_KEY);
  } catch {
    // ignore
  }
}

// ---------------------------------------------------------------------------
// Account list
//
// The server already supports many users and many concurrent sessions, so
// "multiple accounts" is purely a matter of remembering more than one token
// here and choosing which to send.
// ---------------------------------------------------------------------------

export function listAccounts(): StoredAccount[] {
  try {
    const raw = localStorage.getItem(ACCOUNTS_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (a) => a && typeof a.token === 'string' && a.user && a.user.id != null,
    );
  } catch {
    return [];
  }
}

function writeAccounts(accounts: StoredAccount[]): void {
  try {
    localStorage.setItem(ACCOUNTS_KEY, JSON.stringify(accounts));
  } catch {
    // ignore — switching just won't persist across reloads
  }
}

/** Add or replace an account, then make it the active one. */
function rememberAccount(token: string, user: AuthUser): void {
  // Keyed on user id, so signing into the same account twice replaces the
  // old token rather than showing the account twice in the menu.
  const others = listAccounts().filter((a) => a.user.id !== user.id);
  writeAccounts([...others, { token, user }]);
  storeSessionToken(token);
  endGuest(); // a real sign-in ends guest mode
}

export function getActiveAccount(): StoredAccount | null {
  const token = getSessionToken();
  return listAccounts().find((a) => a.token === token) ?? null;
}

export function switchAccount(token: string): void {
  if (listAccounts().some((a) => a.token === token)) {
    endGuest(); // moving to a real account supersedes guest mode
    storeSessionToken(token);
  }
}

// ---------------------------------------------------------------------------
// Guest mode
//
// "No thanks" lets someone use Jarvis without an account. This is entirely
// client-side: no row in users.db, no session on the server, no password.
// It is a local preference saying "skip the gate on this browser".
// ---------------------------------------------------------------------------

/**
 * Stand-in user for guest mode. The id is negative so it can never collide
 * with a real row — SQLite AUTOINCREMENT ids start at 1.
 */
export const GUEST_USER: AuthUser = {
  id: -1,
  email: '',
  display_name: 'Guest',
  created_at: 0,
};

export function isGuest(user: AuthUser | null | undefined): boolean {
  return !!user && user.id === GUEST_USER.id;
}

export function isGuestActive(): boolean {
  try {
    return localStorage.getItem(GUEST_KEY) === 'true';
  } catch {
    return false;
  }
}

export function continueAsGuest(): AuthUser {
  try {
    localStorage.setItem(GUEST_KEY, 'true');
  } catch {
    // Guest mode then lasts for this tab only.
  }
  return GUEST_USER;
}

export function endGuest(): void {
  try {
    localStorage.removeItem(GUEST_KEY);
  } catch {
    // ignore
  }
}

/**
 * Make sure the session we are actually using appears in the account list.
 *
 * A token can be valid without having an entry here: it was created before
 * multi-account support existed, or the accounts key was cleared while the
 * session key survived. Without this backfill the account menu renders no
 * accounts at all — just "Add account" and "Sign out".
 */
export function adoptActiveSession(user: AuthUser): void {
  const token = getSessionToken();
  if (!token) return;
  const accounts = listAccounts();
  if (accounts.some((a) => a.token === token)) return;
  writeAccounts([
    ...accounts.filter((a) => a.user.id !== user.id),
    { token, user },
  ]);
}

/** Session header for the current token, or {} when signed out. */
export function authHeaders(): Record<string, string> {
  const token = getSessionToken();
  return token ? { [SESSION_HEADER]: token } : {};
}

async function readError(res: Response, fallback: string): Promise<string> {
  try {
    const body = await res.json();
    if (body && typeof body.detail === 'string') return body.detail;
  } catch {
    // non-JSON error body
  }
  return fallback;
}

export async function fetchAuthStatus(): Promise<AuthStatus> {
  const res = await fetch(`${getBase()}/v1/auth/status`, {
    headers: { ...authHeaders() },
  });
  if (!res.ok) throw new Error('Could not reach the Vega server.');
  return res.json();
}

async function submitCredentials(
  path: 'signup' | 'signin',
  body: Record<string, string>,
  fallbackError: string,
): Promise<AuthUser> {
  const res = await fetch(`${getBase()}/v1/auth/${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(await readError(res, fallbackError));
  const data = await res.json();
  rememberAccount(data.token, data.user as AuthUser);
  return data.user as AuthUser;
}

export function signUp(
  email: string,
  password: string,
  displayName: string,
): Promise<AuthUser> {
  return submitCredentials(
    'signup',
    { email, password, display_name: displayName },
    'Could not create the account.',
  );
}

export function signIn(email: string, password: string): Promise<AuthUser> {
  return submitCredentials(
    'signin',
    { email, password },
    'Could not sign in.',
  );
}

/**
 * Sign out of the ACTIVE account only.
 *
 * Returns the account that becomes active afterwards, or null when that was
 * the last one and the app should fall back to the sign-in screen. Other
 * signed-in accounts keep their sessions.
 */
export async function signOut(): Promise<StoredAccount | null> {
  const token = getSessionToken();

  // Guest mode has no server session to end — just drop the local flag.
  if (!token) {
    endGuest();
    return null;
  }

  try {
    await fetch(`${getBase()}/v1/auth/signout`, {
      method: 'POST',
      headers: { ...authHeaders() },
    });
  } catch {
    // Even if the server call fails, drop the local token below.
  }

  const remaining = listAccounts().filter((a) => a.token !== token);
  writeAccounts(remaining);

  const next = remaining[remaining.length - 1] ?? null;
  if (next) {
    storeSessionToken(next.token);
  } else {
    clearSessionToken();
  }
  return next;
}
