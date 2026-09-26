# Vega — Implementation Plan

Last updated: 10 Aug 2026.

## Phase 0 — Environment (✅ done)

- Rust toolchain (rustup 1.97) + VS Build Tools (MSVC) installed via winget.
- Python 3.12 pinned (`.python-version`), `uv sync --extra server --extra speech`.
- Rust extension built: `uv run maturin develop -m rust/crates/openjarvis-python/Cargo.toml`.
- Frontend deps + production build into `src/openjarvis/server/static`.
- Config initialised: `jarvis init --engine ollama`, default model `qwen3:latest`.
- **Aug 2026 hardening:** venv migrated from uv's *managed* Python store
  (intermittently broke on Windows → random "No Python at…" launcher
  failures) to **system Python 3.12** (`%LOCALAPPDATA%\Programs\Python\Python312`,
  winget `Python.Python.3.12`). Launcher pins `UV_PYTHON` +
  `UV_PYTHON_DOWNLOADS=never` and serves with `uv run --no-sync` (uv's
  implicit sync uninstalls the maturin-built `openjarvis_rust`).
  Rebuild recipe after any venv recreation:
  `uv venv --clear --python %LOCALAPPDATA%\Programs\Python\Python312\python.exe`
  → `uv sync --extra server --extra speech`
  → `uv run --no-sync maturin develop -m rust/crates/openjarvis-python/Cargo.toml`.

## Phase 1 — Core running (✅ done)

- CLI proof: `jarvis ask` via local Ollama.
- Server at `127.0.0.1:8000` serving API + web UI; chat round-trip verified.
- Launchers: `start-jarvis.bat` (port-free → Ollama check → server window → open browser), `stop-jarvis.bat`.

## Phase 2 — Cloud models, done right (✅ done — local fixes)

| Fix | Files |
|---|---|
| Key saved in UI now persists server-side (was Tauri-only; browsers silently broken) | `server/routes.py` (`POST/GET /v1/cloud-keys`), `frontend/src/lib/api.ts`, `components/CommandPalette.tsx` |
| Removed phantom `gemini-3-pro` (404) from hardcoded list | `CommandPalette.tsx` |
| Live model lists fetched with the stored key, all four providers, per-provider chat-model filtering | `server/routes.py` (`GET /v1/cloud-models` + `_google/_openai/_anthropic/_openrouter_models`), `api.ts`, `CommandPalette.tsx` |
| Key file (`~/.openjarvis/cloud-keys.env`) re-read per request → zero-restart key changes | upstream behavior, leveraged |

## Phase 3 — Voice input (✅ done — local fixes)

- `--extra speech` installed; `[speech]` config: faster-whisper / base / cpu / int8.
- **Windows bug fixed**: temp audio file closed before transcription (`speech/faster_whisper.py`) — exclusive lock made every transcription 500 before.
- **Permissions-Policy fixed**: `microphone=(self)` (`server/middleware.py`) — upstream header blanket-blocked the app's own mic.
- Whisper model pre-downloaded; `/v1/speech/health` + silent-clip round-trip verified.
- **Live dictation preview**: 1.5 s recorder timeslice; cumulative-audio preview transcription with single-in-flight guard (`hooks/useSpeech.ts`); typed-text-preserving replace logic (`components/Chat/InputArea.tsx`).

## Phase 4 — Telemetry, privacy, accounts, rename (✅ done — Aug 2026)

### 4a. SYSTEM panel showed zeros for cloud sessions
Two independent causes, both fixed:

| Cause | Fix |
|---|---|
| `/v1/savings` filters out cloud models by id prefix, so a cloud-only session reported 0 calls / 0 tokens | Added `cloud_*` + combined `session_*` fields (`server/savings.py`, `server/routes.py`); the savings maths is untouched |
| `savings?.total_calls ?? telemetry?.total_requests` — `??` does not fall through on a real `0`, so the telemetry fallback was dead | Panel reads the new `session_*` fields (`components/Chat/SystemPanel.tsx`) |

Cost Comparison now uses combined session tokens, so it moves on cloud
calls. A "N cloud · M local" caption was added. Also removed a
`useEffect` that re-fetched whenever `savings` changed — now that the panel
writes `savings` itself each poll, that effect would have looped.

**Power/Energy are `n/a`, not a bug.** Probed `create_energy_monitor()` on
this machine: returns `None`. The backends are NVIDIA, AMD, Apple and Linux
RAPL; there is no `nvidia-smi` here and RAPL is Linux-only. The energy
endpoint now reports `energy_available` / `energy_vendor` (cached probe) and
the UI shows `n/a` with the reason.

### 4b. Third-party data removed
- **Supabase leaderboard upload deleted** — it POSTed display name, **email
  address** and usage stats to `savings_entries` every 30 s, with no delete
  path. Removed from `lib/api.ts` (function, URL and embedded anon key),
  `App.tsx`, `components/Desktop/SavingsDashboard.tsx`, and the LEADERBOARD
  section of `SystemPanel.tsx`. Verified: 0 occurrences of `supabase` /
  `savings_entries` / `Share Your Savings` in the built bundle.
- **Startup update check disabled** — `cli/_version_check.py` gained
  `UPDATE_CHECK_ENABLED = False` and returns before any network code; the
  call site in `cli/__init__.py` was removed as well. Stale
  `~/.openjarvis/version-check.json` deleted. This was the only thing
  contacting the internet without the user asking.
- Full audit written up in PROJECT-REQUIREMENTS.md §8.

### 4c. Local accounts
- `server/auth_store.py` — SQLite `~/.openjarvis/users.db` (mode 0600),
  PBKDF2-HMAC-SHA256 / 240 000 iterations / per-user salt, sessions with
  30-day expiry.
- `server/auth_routes.py` — `/v1/auth/{status,signup,signin,signout,me}`,
  token in an `X-OJ-Session` header (not `Authorization`, to avoid
  colliding with the optional shared API key).
- `frontend/src/lib/auth.ts`, `components/AuthScreen.tsx`,
  `components/Sidebar/AccountMenu.tsx`, store + `App.tsx` gate.
- **Multiple accounts**: `openjarvis-accounts` in localStorage holds
  `[{token,user}]`; switching changes the active token. Sign-out ends only
  the active account's server session.
- **Guest mode**: "No thanks" sets a local flag — no DB row, no server
  session. Verified end to end in a browser (menu reads
  "Guest / No account / Sign in / Exit guest mode").
- `adoptActiveSession()` backfills a valid token that predates the account
  list, which otherwise rendered the menu empty.

### 4d. Live Ollama model browser
- `server/ollama_library.py` + `GET /v1/ollama/library`. Ollama has no
  catalogue API (`/v2/_catalog` and `/v2/<name>/tags/list` both 404), so the
  library page is scraped, parsed and cached to
  `~/.openjarvis/ollama-library.json`. Runs server-side because CSP is
  `default-src 'self'`.
- Parser keys off `/library/<name>` links and size-chip *shape*, not CSS
  class names. Tested against the live page: 231 models, 0 missing
  descriptions.
- Download tab replaced its 12-item hardcoded list; one pull button per
  published size tag, search, refresh, installed-tag ticks. The hardcoded
  list survives only as an offline fallback.

### 4e. Rename to Vega
Display name only — tab title, PWA manifest, sign-in screen, chat
placeholder, error banner, setup screen, Settings, and 22 setup-instruction
strings (what to name your own Slack app / Notion integration).

Deliberately **not** renamed: the `openjarvis` Python package (2,517 import
paths), `~/.openjarvis/` paths, `openjarvis-*` localStorage keys (renaming
would have logged the user out), the Slack icon URL, `OpenJarvis.app`, and
the desktop release filenames. Settings → About credits the upstream
project. The Get Started page still says OpenJarvis because its download
links and filenames are genuinely upstream.

## Phase 5 — Known paper-cuts / next steps (⬜ open)

1. **Upstream the fixes** as PRs (key persistence, live models, phantom
   model, Windows tempfile, Permissions-Policy, cloud telemetry, `doctor`
   cp1252 crash). Needs a proper git clone first.
2. Re-clone as a git repo so upstream updates can merge with local patches.
3. Rotate the Gemini API key (exposed in screenshots/error URLs during setup)
   — AI Studio → delete + recreate → re-paste in Cloud Models. **Still open.**
4. In-app "UI updated — reload" toast to end the service-worker ritual
   (SW `skipWaiting` + refresh prompt). Now the most annoying paper-cut:
   the stale bundle has bitten twice.
5. `aria-label`s on icon-only buttons (mic, send, account-menu trigger).
6. De-duplicate the cloud price table — it exists in both
   `server/savings.py` and `SystemPanel.tsx`, which does its own maths.
7. Add `font-src` to the CSP; KaTeX maths fonts are currently blocked.
8. Optional: enforce the account gate server-side. Today it is UI-only —
   would need the CLI, channels and webhooks handled so they are not locked out.
9. Optional: scope chat history per account (today all accounts share one
   conversation list).

## Phase 6 — Feature roadmap (⬜ candidates, in rough order of value)

1. **Memory/RAG over personal documents** — `jarvis memory index <folder>`; verify retrieval-grounded answers in chat (Rust extension already built for this).
2. **Gemini Pro via billing** — attach billing in AI Studio if Pro-level answers are wanted; UI already labels which models need it.
3. **Messaging channel** — e.g. Telegram bot (`jarvis channel …`) for phone access on the LAN.
4. **Morning digest preset** — needs Data Sources (Gmail/Calendar OAuth) wiring.
5. **TTS (speak answers back)** — speech module has kokoro/openai/cartesia TTS backends; would complete the voice loop. Note the openai/cartesia backends send text to those providers; kokoro is local.
6. **Scheduler/monitors** — recurring agents (`jarvis scheduler`).

## Working agreements (how changes ship on this machine)

- **Backend change** → restart via `start-jarvis.bat`.
- **Frontend change** → `npm run build` in `frontend/`, then clear the
  service worker. Closing the tab is **not** enough — the SW serves a cached
  `index.html` pointing at the old bundle. Paste into the browser console:

  ```javascript
  (async()=>{for(const r of await navigator.serviceWorker.getRegistrations())await r.unregister();for(const k of await caches.keys())await caches.delete(k);location.reload()})()
  ```

  Or F12 → Application → Storage → Clear site data.
- **Document-level changes** (headers/manifest) → also bump the `oj-build`
  meta marker in `frontend/index.html`.
- **Verify after deploy**: `curl 127.0.0.1:8000/health`,
  `/v1/auth/status`, `/v1/ollama/library`, `/v1/speech/health`, and confirm
  the served `index-*.js` hash changed. A `200` that returns **HTML** for a
  `/v1/*` path means the route is not registered and the SPA catch-all
  answered — restart the server.
- Windows console commands that print rich output: prefix `PYTHONUTF8=1`.
- Python syntax check without starting anything:
  `python -m py_compile <files>`.
