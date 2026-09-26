# Vega — Technical Requirements Document (TRD)

> Display name is **Vega**; the Python package remains `openjarvis` and the
> data directory remains `~/.openjarvis/`. See PROJECT-REQUIREMENTS.md
> §Naming. Last updated: 10 Aug 2026.

## 1. Stack

| Layer | Technology |
|---|---|
| Backend | Python 3.12 — **system install** (`%LOCALAPPDATA%\Programs\Python\Python312`, winget), venv managed by uv with `UV_PYTHON_DOWNLOADS=never`; FastAPI + Uvicorn, httpx. (uv's *managed* Python store proved intermittently broken on Windows — random "No Python at…" launcher failures — and is deliberately unused.) |
| Native extension | Rust (PyO3 / maturin, `openjarvis_rust` cp312 wheel) — memory & security features |
| Local inference | Ollama (`http://localhost:11434`), models: qwen3, qwen2.5-coder-7b/1.5b, deepseek-coder-1.3b |
| Cloud inference | Direct httpx calls: Google `generativelanguage.googleapis.com`, OpenAI, Anthropic, OpenRouter (`server/cloud_router.py`) |
| Speech-to-text | faster-whisper 1.2.1 (CTranslate2), model `base`, device `cpu`, compute `int8` |
| Accounts | SQLite `~/.openjarvis/users.db`, PBKDF2-HMAC-SHA256 (stdlib `hashlib`) — no new dependency |
| Frontend | React 19, TypeScript, Vite 6, Tailwind 4, zustand, react-router 7, PWA (vite-plugin-pwa / Workbox) |
| Desktop shell (unused here) | Tauri 2 |
| Toolchain | uv 0.11, Rust 1.97 (MSVC + VS Build Tools), Node 25 |

## 2. Runtime topology

```
Browser (127.0.0.1:8000)
   │  static UI (built into src/openjarvis/server/static, PWA-cached)
   │  /v1/* JSON + SSE          X-OJ-Session: <token> on /v1/auth/*
   ▼
FastAPI server (uv run jarvis serve, port 8000)
   ├─ engine: ollama  ──► Ollama daemon :11434 ──► local GGUF models
   ├─ cloud_router    ──► provider APIs (keys from ~/.openjarvis/cloud-keys.env, re-read PER REQUEST)
   ├─ auth_store      ──► ~/.openjarvis/users.db (accounts + sessions)
   ├─ ollama_library  ──► ollama.com/library (scraped, cached; no user data sent)
   ├─ speech backend  ──► faster-whisper (in-process, HF cache model)
   ├─ agents/tools    ──► code_interpreter, web_search, file_read, shell_exec
   └─ telemetry/sessions/memory (openjarvis_rust)
```

## 3. Environment requirements

- `PYTHONUTF8=1` for any CLI output on Windows consoles (rich ✓ glyphs crash cp1252 otherwise). The launcher sets it.
- Port 8000 free (launcher force-frees it), Ollama on 11434.
- HuggingFace access on first Whisper use (model cached at `~\.cache\huggingface\hub\models--Systran--faster-whisper-base`).
- Internet access to `ollama.com` the first time the Download tab is opened; afterwards the cached list at `~/.openjarvis/ollama-library.json` serves offline.
- Google AI Studio key format: `AQ.…` (current) — stored server-side, names-only ever returned to clients.

## 4. Security requirements

- Server binds `127.0.0.1` only.
- Security headers middleware (`server/middleware.py`): nosniff, DENY framing, HSTS, CSP, and `Permissions-Policy: camera=(), microphone=(self), geolocation=()` — microphone allowed **for same origin only** (required by the mic feature; camera/geo stay blocked).
- **CSP is `default-src 'self'`.** The page cannot fetch third-party hosts, which is why the Ollama library listing is proxied through the server rather than fetched in the browser. (Known cosmetic side effect: KaTeX maths fonts are inlined as `data:` URIs and are blocked, because `font-src` is not declared.)
- API keys: plaintext in `~/.openjarvis/cloud-keys.env` (user-profile file). Endpoints accept a whitelisted set of key NAMES; values are never returned by any endpoint (`GET /v1/cloud-keys` → names only).
- Keys must never appear in error URLs shared publicly (Google embeds `key=` in request URLs — error copies leak it; rotate if leaked).
- **Account passwords**: PBKDF2-HMAC-SHA256, 240 000 iterations, 16-byte per-user salt, compared with `secrets.compare_digest`. Never stored or recoverable in plaintext. `users.db` is created via `secure_create` with mode `0600`.
- **Session tokens**: `secrets.token_urlsafe(32)`, 30-day expiry, sent in an `X-OJ-Session` header — deliberately *not* `Authorization`, so it cannot collide with the optional shared API key checked by `AuthMiddleware`.
- Sign-in returns one message for both "unknown email" and "wrong password", and spends comparable time on a miss, so responses cannot be used to enumerate registered addresses.
- **Scope limit:** the account gate is enforced in the UI only. `/v1/*` remains open to anything that can reach loopback. Enforcing it server-side would require handling the CLI, channels and webhooks and has not been done.

## 5. Performance expectations (this machine, CPU-only)

| Operation | Expected |
|---|---|
| Local 7B chat answer | ~15–30 s |
| Cloud Flash answer | ~1–3 s |
| Whisper `base` transcription | ~1–3 s per short utterance; live preview ticks every 1.5 s + transcription time |
| Sign-in / sign-up | ~0.2–0.4 s (dominated by the PBKDF2 work factor, deliberately) |
| Ollama library fetch | ~1–3 s cold, instant from cache (6 h TTL) |
| Frontend production build | ~1–2 min warm, ~5–8 min cold |
| Rust extension build | one-time ~5–15 min |

## 6. Build & deploy requirements

- Backend changes → restart server (`start-jarvis.bat` handles kill+start).
- Frontend changes → `cd frontend && npm run build` (outputs to `src/openjarvis/server/static`), then **clear the service worker** — see IMPLEMENTATION-PLAN.md §Working agreements. Closing the tab is *not* reliably enough. If headers/doc-level behaviour changed, also bump the `oj-build` meta marker in `frontend/index.html`.
- Config-only changes (`config.toml`, `cloud-keys.env`) → no restart for cloud keys (read per request); restart for `[engine]`/`[speech]` changes.

## 7. Compatibility notes / local fixes already applied

1. `speech/faster_whisper.py` — temp file closed before transcription (Windows exclusive-lock bug).
2. `server/middleware.py` — `microphone=(self)`.
3. `server/routes.py` — `/v1/cloud-keys` (GET/POST), `/v1/cloud-models` (live per-provider listing).
4. `frontend` — key save posts to server; live model lists; dictation live preview (1.5 s timeslice).
5. Python pinned 3.12 via `.python-version` (PyO3 wheel target).
6. `server/routes.py` `_handle_stream` — publishes a `TelemetryRecord` for **cloud** streams, which were previously invisible to telemetry.
7. `server/savings.py` + `/v1/savings` — added `cloud_*` and `session_*` totals. The pre-existing `total_*` fields count local inference only, so a cloud-only session reported zero everywhere.
8. `server/api_routes.py` `/v1/telemetry/energy` — reports `energy_available` / `energy_vendor` (cached probe) so the UI can distinguish "0 W because nothing ran" from "no sensor exists".
9. `server/auth_store.py`, `server/auth_routes.py` — local accounts (new).
10. `server/ollama_library.py` + `/v1/ollama/library` — live model catalogue (new).
11. `cli/_version_check.py` + `cli/__init__.py` — startup update check **disabled**.
12. Supabase leaderboard upload **removed** from `frontend/src/lib/api.ts`, `App.tsx` and `components/Desktop/SavingsDashboard.tsx`, including the embedded URL and anon key.
