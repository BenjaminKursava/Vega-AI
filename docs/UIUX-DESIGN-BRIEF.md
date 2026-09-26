# Vega — UI/UX Design Brief

Last updated: 10 Aug 2026.

## 1. Product personality

Calm, private, technical-but-friendly. The interface should feel like a
**quiet local tool**, not a SaaS: no upsells, no growth prompts. The only
"marketing" surface is the cost-comparison panel proving local = $0.

The sign-in that now gates the app is the one deliberate exception, and it
is framed to match: the screen states plainly that the account is stored on
this computer and that the email and password never leave it.

Removed Aug 2026 for being off-personality: the "Share Your Savings"
leaderboard opt-in, which asked for an email address in exchange for a
prize-draw entry and uploaded name + email + usage every 30 s.

## 2. Layout (desktop-first, 3 columns)

```
┌ Sidebar ──────────┬ Chat ─────────────────────────────┬ SYSTEM panel ────┐
│ model chip (⌘K)   │ greeting / message thread         │ SESSION: requests │
│ search chats      │ user bubbles right (teal)         │  + output tokens  │
│ conversation list │ assistant markdown left           │  "N cloud · M local"│
│ nav: Chat,        │ per-reply meta chip:              │ DEVICE: power /   │
│  Dashboard, Data  │  "ollama · model · trivial · 23s" │  energy (or n/a)  │
│  Sources, Agents, │ input bar: textarea + mic + send  │ COST COMPARISON:  │
│  Logs, Settings,  │ hint: Enter to send               │  Local $0 vs GPT/ │
│  Get Started      │                                   │  Claude/Gemini    │
│ ── account menu ──│                                   │                   │
│  (S) name ▸       │                                   │                   │
│      email        │                                   │                   │
└───────────────────┴───────────────────────────────────┴──────────────────┘
```
Theme: light/dark/system toggle. Fonts: Geist (variable). Icons: lucide-react.
Toasts: sonner. Charts (Dashboard): recharts.

The LEADERBOARD section that used to sit below Cost Comparison is gone.

## 3. Key components & states

### Auth screen (full-window, blocks everything)
- Shield icon, then one of three headings: **Create your account** (first
  run) · **Welcome back** (returning) · **Add another account** (from the
  account menu, cancellable).
- Fields: Name *(optional)*, Email, Password — each with a leading icon.
  Password hint "At least 8 characters" shown only when signing up.
- Primary button, then a mode-switch link, then **Cancel** (add-account
  only), then a divider and **No thanks** for guest mode with the caption
  "Use Vega without an account. You can sign in later from the account menu."
- Footer, always: "This account is stored only on this computer, in
  `~/.openjarvis/users.db`. Your email and password are never sent
  anywhere else." The privacy claim is load-bearing — do not delete it.
- One error line for both wrong-password and unknown-email, matching the
  server, so the UI cannot be used to discover who has an account.

### Account menu (sidebar footer)
- Trigger row: gradient avatar with initials ("Appu k" → **AK**, or the
  first letter of the email), display name or email, secondary line with
  the email (or "Not signed in" for guests), chevron.
- Popup opens **upward** (the trigger is at the bottom), closes on
  outside-click or Escape:
  - one row per signed-in account — avatar, name, email, tick on the active
    one; clicking another switches instantly, no password
  - divider
  - **Add account** / **Sign in** (guest) · **Sign out** / **Exit guest mode**
- The signed-in user is always rendered even if the stored account list is
  empty, so the menu can never appear with no accounts in it.

### Model picker (Command Palette, ⌘K / chip click)
- Tabs: **Installed Models (n)** (Ollama, local) · **Download** · **Cloud Models**.
- Download tab is **live**: the whole Ollama library (~231 models), with a
  count line ("42 of 231 models matching …") and a **Refresh** link.
  Each model is one row — name, capability chips (`tools`, `vision`,
  `embedding`), description, then one small button per published size.
  Installed tags show a tick and are disabled. A free-text box below takes
  any exact tag for community models.
  Loading and "showing a cached copy" states are both surfaced rather than
  silently degrading.
- Cloud Models tab per provider (OpenAI, Anthropic, Google, OpenRouter):
  - masked key input (eye toggle) + red **Remove** button when set
  - green **Connected** badge when a key exists
  - model rows: id (mono), one-line desc, **Active** badge for the selected one
  - lists are LIVE (fetched with the stored key) — falls back to a small static list without a key
- Footer note: "API keys are stored locally and never sent to Vega servers".

### SYSTEM panel
- **Session**: Requests and Output Tokens, counting local **and** cloud.
  A caption reads "N cloud · M local" whenever any cloud call happened —
  without it, "Local $0.0000" sitting beside real cloud costs misleads.
- **Device**: Power and Energy, or **n/a** with the explanation "No power
  sensor on this device — needs an NVIDIA GPU, an Apple chip, or Linux
  RAPL." Showing a confident `0.0 W` when nothing can be measured is a lie;
  `n/a` is not.
- **Cost Comparison**: hypothetical spend for this session's token volume at
  GPT-5.3 / Claude Opus 4.6 / Gemini 3.1 Pro prices, against Local $0.
  A green delta appears per row when the saving exceeds $0.0001 — which is
  why low-token sessions show it on some rows and not others.
  *Known duplication:* the price table exists both in `server/savings.py`
  and in `SystemPanel.tsx`, which does its own arithmetic. Change both or
  the Dashboard and the panel will disagree.

### Mic button (input bar)
- idle: grey mic · recording: **red pulsing** (1.5 s CSS pulse) · transcribing: spinner
- disabled states with tooltip: "Enable in Settings" / "Speech backend not configured" / "Wait for response"
- Live dictation: text appears in the field in bursts while speaking; final pass replaces the preview on stop. Typed text before dictation is always preserved.

### Payment-ish moments (cloud errors)
- Errors render inline in the thread as plain text with the failing URL — must never be styled as success; keep them selectable for debugging (but educate: URLs can embed the key).

## 4. Interaction principles

1. **Latency honesty** — every reply shows engine, model and elapsed time; never hide that local CPU is slow.
2. **No dead buttons** — if a capability is missing (speech off, no key), the control is visible but disabled *with a tooltip explaining how to enable it*.
3. **Paste-and-it-works** — any credential pasted in the UI must fully activate the feature; no file editing, no restarts.
4. **Say "n/a", never a confident zero** — a measurement that cannot be taken must not be rendered as though it were taken. Applies to Power/Energy today.
5. **PWA awareness** — after UI updates the service worker must be cleared, not just the tab closed; an in-app "update available" toast remains the proper fix.
6. **Keyboard**: Enter send, Shift+Enter newline, ⌘K model picker, Ctrl+I system panel, Escape closes the account menu.

## 5. Accessibility

- All icon-only buttons need `aria-label`s (mic/send have visual-only affordances today — improve). The account-menu trigger has no accessible name either: its text sits in nested divs, so screen readers and the a11y tree see an unnamed button.
- Status colors must not be the only signal (badges carry text: Active/Connected; the active account carries a tick, not just weight).
- prefers-reduced-motion respected for spinner/pulse animations (already in fv-spinner CSS pattern).

## 6. Visual language quick reference

- Accent: teal (`--color-accent`, #0f766e family) · Error: red family · Success: green.
- Avatars: 26 px circle, accent→purple gradient, white 11 px semibold initials; muted grey fill for inactive accounts.
- Radius: 10–12 px on cards/tiles/buttons; pill badges; 12 px on the account popup with a heavy soft shadow.
- Selected tiles: 1.5 px teal border + pale-teal fill (#f0fdfa pattern).
