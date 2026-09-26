# Gava — App Flow

Last updated: 20 Aug 2026.

## 1. Startup flow

```
User double-clicks start-jarvis.bat
  ├─ kill anything LISTENING on :8000        (stale server cleanup)
  ├─ Ollama on :11434?  no → open "Ollama" window (ollama serve)
  ├─ open "Gava Server (:8000)" window (uv run jarvis serve, PYTHONUTF8=1)
  │     server: loads config.toml → engine=ollama, agent=orchestrator,
  │             speech=faster-whisper, memory=active → serves UI + /v1 API
  │     NO update check — disabled Aug 2026; the server contacts nobody on boot
  └─ after 12 s → default browser opens http://127.0.0.1:8000
Stop: close server window / Ctrl+C / stop-jarvis.bat (Ollama left running)
```

## 2. Sign-in flow (gate)

```
Browser loads / → GET /v1/auth/status
  ├─ signed_in            → straight to Chat
  ├─ guest flag in local  → straight to Chat as Guest
  └─ otherwise            → AuthScreen, and nothing else renders

AuthScreen
  ├─ has_account = false  → opens on "Create your account"
  ├─ has_account = true   → opens on "Welcome back" (sign in)
  └─ "No thanks"          → guest mode: localStorage flag only,
                            no row in users.db, no server session

Sign up / sign in
  → POST /v1/auth/{signup,signin} {email, password}
  → server: PBKDF2 verify → create session row → {token, user}
  → browser stores {token, user} in openjarvis-accounts,
    token in openjarvis-session, clears any guest flag
  → app renders
```

A valid session that predates the account list is **backfilled** on startup
(`adoptActiveSession`), otherwise the account menu would render empty.

## 3. Account switching flow

```
Sidebar footer shows: avatar (initials) · name · email  ▸
click → popup ABOVE the row:
  ├─ one row per signed-in account, tick on the active one
  │    click another → switch active token → no password needed
  ├─ "Add account"   → AuthScreen in add mode (current account stays
  │                     signed in; Cancel returns)
  └─ "Sign out"      → ends THIS account's server session only.
                       Another account signed in? → become that one.
                       Last one? → back to AuthScreen.
Guest mode relabels these to "Sign in" and "Exit guest mode".
```

## 4. Chat flow (local model)

```
type message → Enter
  → POST /v1/chat/completions (stream, model, history)
  → orchestrator classifies complexity (trivial/complex)
  → routes to a local model via Ollama (e.g. trivial → qwen2.5-coder:7b)
  → SSE tokens stream back → UI renders markdown progressively
  → footer chip: "ollama · <model> · <complexity> · <latency>"
  → SYSTEM panel updates: requests, output tokens, cost comparison
```

## 5. Cloud model flow (e.g. Gemini)

```
Model picker (chip top-left) → Cloud Models tab
  paste key → blur (click outside)
    ├─ localStorage (UI state, "Connected" badge)
    ├─ POST /v1/cloud-keys {name, value} → ~/.openjarvis/cloud-keys.env
    └─ GET /v1/cloud-models?provider=… → live model list rendered
  select model (e.g. gemini-flash-latest) → chat as normal
    → server reads key file PER REQUEST → provider API (SSE) → stream to UI
    → after the stream, a TelemetryRecord(engine="cloud") is published so
      the SYSTEM panel counts it (it did not, before Aug 2026)
  Remove key → POST empty value → file line deleted → list falls back to static
Errors surfaced verbatim in chat:
  429 = provider quota (free tier / needs billing) · 404 = model id not offered
  "GEMINI_API_KEY not set" = key never reached the server file
```

**Privacy note:** with a cloud model selected, the full message text — plus
any data-source snippets retrieved to answer it — is sent to that provider.

## 6. Model download flow

```
Ctrl+K → Download tab
  → GET /v1/ollama/library (server scrapes ollama.com, 6 h cache)
  → ~231 models listed: name, description, capability chips
  → each published size is its own pull button: qwen3 + "8b" → qwen3:8b
  → already-installed tags show a tick and are disabled
  → search filters name / description / capability
  → "Refresh" bypasses the cache (for models published since last fetch)
  → or type any exact tag in the free-text box (community models,
    user/model:tag — the pull endpoint has no whitelist)
  → POST /v1/models/pull → Ollama /api/pull

Failure to know about: "pull model manifest: file does not exist" means
Ollama's registry has no such model — not an app bug. A HuggingFace release
name (e.g. DeepSeek-V4-Flash-0713) is not an Ollama tag; someone must
convert and publish it first.
```

## 7. Voice input flow

```
click mic
  → getUserMedia (first time: browser permission prompt;
     allowed by Permissions-Policy microphone=(self))
  → MediaRecorder.start(1500)  — 1.5 s chunks accumulate
  LIVE PREVIEW loop (while recording):
     every chunk → if no preview request in flight:
        Blob(all chunks so far) → POST /v1/speech/transcribe
        → faster-whisper (base/int8/CPU) → text
        → input field := typed-base + " " + preview text
click mic again (stop)
  → final transcription of the full recording (authoritative)
  → input field := typed-base + " " + final text → user edits/sends
```

Audio never leaves the machine — faster-whisper runs in-process and the
speech module contains no upload code.

## 8. Diagnostics flow

- **Logs page** — agent reasoning steps: thought → tool call → observation.
- **Server window** — request log lines (`GET /v1/... 200`).
- **CLI**: `PYTHONUTF8=1 uv run jarvis doctor` — engine reachability, models,
  speech backend, optional extras, security profile hints.
- **Speech health**: `GET /v1/speech/health` → `{"available":true,"backend":"faster-whisper"}`.
- **Auth health**: `GET /v1/auth/status` → `{"has_account":…,"signed_in":…}`.
  A `200` returning **HTML** means the route is not registered and the SPA
  catch-all answered — i.e. the server needs restarting.

## 9. Update flow (after code changes)

```
backend .py changed  → start-jarvis.bat (restart)
frontend changed     → cd frontend && npm run build
                       → clear the service worker (see below) → reload
both                 → build, restart, then clear SW
```

Closing and reopening the tab is **not** reliably enough: the PWA service
worker serves a cached `index.html` that still points at the old bundle.
Confirmed twice in practice. Clearing snippet is in IMPLEMENTATION-PLAN.md
§Working agreements.

## 10. Session/history flow

Conversations listed in the left sidebar (search box, New chat). Selecting a
conversation loads its messages; the active model shows in the top-left chip
and is remembered per selection.

**Chats are not scoped per account** — conversation history lives in browser
storage globally, so switching accounts shows the same list. Accounts
control access to the app, not separate workspaces.

## 11. Attachments flow (files & photos)

```
paperclip button (or paste a file/screenshot into the input)
  ├─ image/*   → downscaled client-side to ≤1024 px JPEG (canvas)
  │             → thumbnail chip above the input → stored on the message
  │             → sent as base64 in messages[].images
  │             → server carries it in Message.metadata["images"]
  │             → Ollama /api/chat "images" field (native multimodal format)
  │             → a VISION model (llava, qwen-vl, gemma3, moondream…) reads it
  ├─ text-like → .txt .md .csv .json code files … up to 200 KB
  │             → file chip; content is inlined into the prompt at SEND time
  │             → works with every model (it's just prompt text)
  └─ other     → rejected with a note under the input (no PDFs yet)
Limits: 6 attachments per message; images persist in the conversation
(localStorage) as downscaled JPEGs, which is why the downscale matters.
```

Caveats that will save someone an afternoon:

- **Text-only models silently ignore images.** Ollama drops the `images`
  field for non-vision models — the reply will just pretend no image exists.
  Pick a vision model before asking about a photo.
- **Gemini receives images** (converted to `inline_data` parts for the
  google-genai SDK — `_google_user_parts()` in engine/cloud.py). Other cloud
  providers still get text only (`messages_to_dicts(image_style=None)`), and
  the UI shows a note when an image is attached with one of them selected.
  Text-file attachments reach every model, since they ride inside the
  prompt text. Privacy: attaching an image with Gemini selected sends that
  image to Google, same as the §5 note for message text.
- The agent/tools bridge path is text-only; images flow on the plain chat
  path (which is what the UI uses).

## 12. Naming — display name vs functional identifiers

The product's display name is **Gava** (renamed from Vega / OpenJarvis,
Aug 2026). The rename covers what users READ: the launcher window titles and
echo text in `start-jarvis.bat` / `stop-jarvis.bat` (the server window now
opens as "Gava Server (:8000)"), UI labels, and doc titles.

Deliberately NOT renamed — these are functional identifiers the code
references, and changing any of them is a migration, not a find-and-replace:

- `jarvis` — the CLI entry point (`uv run jarvis serve`), defined in
  pyproject.toml. Renaming requires repackaging the environment.
- `openjarvis` — the Python package (`src/openjarvis/…`, every import).
- `openjarvis-*` — the browser localStorage keys (accounts, session,
  conversations). Renaming signs everyone out and orphans saved chats.
- `~/.openjarvis/` — the on-disk config folder (cloud API keys live here).
- `start-jarvis.bat` / `stop-jarvis.bat` — the launcher FILENAMES. Safe to
  rename if ever desired (nothing executes them by name), but several docs
  reference them, so rename both together with a docs sweep.

Rule of thumb: **rename what users read; leave what the code references** —
or plan the latter as a proper migration with data carry-over.
