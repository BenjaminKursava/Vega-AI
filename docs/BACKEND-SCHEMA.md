# Vega — Backend Schema & Data Layout

Vega has **no central SQL database**. State lives in config files, several
small SQLite files in the user-profile data directory, and in-process
stores. This document maps where every piece of data lives and the shapes
that cross the API boundary. Last updated: 10 Aug 2026.

> The data directory is still `~/.openjarvis/` and the Python package is
> still `openjarvis` — only the display name changed. See
> PROJECT-REQUIREMENTS.md §Naming.

## 1. On-disk layout

```
~ (C:\Users\tabsy)
├─ .openjarvis\
│  ├─ config.toml             ← main configuration (see §2)
│  ├─ cloud-keys.env          ← provider API keys, NAME=value per line (see §3)
│  ├─ users.db                ← ACCOUNTS: users + sessions (see §4), mode 0600
│  ├─ telemetry.db            ← request/token/energy records (session-scoped reads)
│  ├─ knowledge.db            ← connector content, chunked + indexed for RAG
│  ├─ sessions.db             ← channel conversation sessions
│  └─ ollama-library.json     ← cached Ollama model catalogue (6 h TTL, offline fallback)
├─ .cache\huggingface\hub\
│  └─ models--Systran--faster-whisper-base\   ← Whisper model (auto-downloaded)
└─ .ollama\                   ← Ollama's own model store (managed by Ollama)

C:\React_js\Jarvis
├─ src\openjarvis\…           ← Python package (server, engines, agents, speech…)
├─ src\openjarvis\server\static\   ← BUILT frontend (vite output; served at /)
├─ frontend\                  ← frontend source (React/TS)
├─ rust\                      ← PyO3 crate (memory/security)
├─ .venv\                     ← uv-managed Python 3.12 env
├─ start-jarvis.bat / stop-jarvis.bat
└─ docs\                      ← these documents
```

Removed Aug 2026: `version-check.json` (the update-check cache) — the check
itself is disabled, so the file is no longer written.

## 2. `config.toml` (active sections on this install)

```toml
[engine]                    # inference backend selection
# provider implied: ollama
[engine.ollama]
# host = "http://localhost:11434"
default_model = "qwen3:latest"

[tools]
enabled = ["code_interpreter", "web_search", "file_read", "shell_exec"]

[speech]                    # added during setup
backend = "faster-whisper"  # auto | faster-whisper | openai | deepgram
model   = "base"            # tiny/base/small/medium/large-v3
device  = "cpu"
compute_type = "int8"
```
Other sections (memory, scheduler, channels, digest…) use defaults.

`web_search` reaches the internet when the agent uses it — Tavily if
`TAVILY_API_KEY` is set, otherwise DuckDuckGo. `shell_exec` and `file_read`
act on this machine.

## 3. `cloud-keys.env`

- One `NAME=value` per line; `#` comments allowed.
- **Re-read on every request** (`cloud_router._load_keys`) → edits are instant.
- Whitelisted names: `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `GEMINI_API_KEY`,
  `GOOGLE_API_KEY`, `OPENROUTER_API_KEY`, `MINIMAX_API_KEY`.
- Process env vars with the same names override the file.

## 4. `users.db` — local accounts (`server/auth_store.py`)

```sql
CREATE TABLE users (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    email         TEXT    NOT NULL,          -- UNIQUE INDEX ... COLLATE NOCASE
    display_name  TEXT    NOT NULL DEFAULT '',
    password_hash BLOB    NOT NULL,          -- PBKDF2-HMAC-SHA256
    salt          BLOB    NOT NULL,          -- 16 random bytes, per user
    iterations    INTEGER NOT NULL,          -- 240000 at time of writing
    created_at    REAL    NOT NULL,
    last_login_at REAL
);

CREATE TABLE auth_sessions (
    token      TEXT    PRIMARY KEY,          -- secrets.token_urlsafe(32)
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at REAL    NOT NULL,
    expires_at REAL    NOT NULL              -- created_at + 30 days
);
```

- `iterations` is stored **per row** so the work factor can be raised later
  without invalidating existing passwords.
- Expired sessions are pruned opportunistically whenever a new one is created.
- No password reset exists. Recovery = delete `users.db` and sign up again;
  nothing else in the app depends on it.

## 5. HTTP API surface (localhost:8000)

### Auth (added locally) — token in the `X-OJ-Session` header
| Endpoint | Shape |
|---|---|
| `GET /v1/auth/status` | `{has_account, signed_in, user}` — drives first-run "Create your account" vs "Sign in" |
| `POST /v1/auth/signup` | `{email, password, display_name?}` → `{token, user}`; 400 on bad input or duplicate email |
| `POST /v1/auth/signin` | `{email, password}` → `{token, user}`; 401 `"Incorrect email or password."` for both failure modes |
| `POST /v1/auth/signout` | deletes the session row for the supplied token |
| `GET /v1/auth/me` | `{user}` or 401 |

`user` is always `{id, email, display_name, created_at}` — the hash and salt
are never serialised.

### Chat / models
| Endpoint | Shape |
|---|---|
| `POST /v1/chat/completions` | OpenAI-compatible: `{model, messages[{role,content}], stream, …}` → SSE chunks / completion object |
| `GET /v1/models` | installed (local) models |
| `POST /v1/models/pull`, `DELETE /v1/models/{name}` | manage Ollama models. **Pull accepts any name** — it is passed straight to Ollama's `/api/pull`, so there is no whitelist |
| `GET /v1/ollama/library?refresh=true` | `{models[{name, description, sizes[], capabilities[], tags[]}], count, fetched_at, stale, source, error}` — see §6 |

### Cloud keys & models (added locally)
| Endpoint | Shape |
|---|---|
| `GET /v1/cloud-keys` | `{present: ["GEMINI_API_KEY", …]}` — names only, never values |
| `POST /v1/cloud-keys` | `{name, value}` → writes/removes line in cloud-keys.env; empty value = remove |
| `GET /v1/cloud-models?provider=google\|openai\|anthropic\|openrouter` | `{models:[{id, desc}]}` fetched live with the stored key; `{models:[], error:"no_key"|…}` on failure |

Provider filters: Google = `gemini-*` chat models minus tts/image/robotics/etc;
OpenAI = `gpt-/o1-/o3-/o4-/chatgpt-` minus audio/realtime/embedding/instruct;
Anthropic = `claude-*` (paginated); OpenRouter = text→text, newest 30.

### Telemetry & savings
| Endpoint | Shape |
|---|---|
| `GET /v1/telemetry/stats` | all engines: `{total_requests, total_tokens, total_latency, …}` |
| `GET /v1/telemetry/energy` | `{total_energy_j, avg_power_w, cpu_temp_c, gpu_temp_c, energy_available, energy_vendor}` |
| `GET /v1/savings` | see below |
| `POST /v1/telemetry/reset` | clears stored records |

`/v1/savings` carries **two different things** and they must not be confused:

- `total_calls`, `total_prompt_tokens`, `total_completion_tokens`,
  `local_cost`, `per_provider`, `monthly_projection` — **local inference
  only**. Cloud models are filtered out by id prefix (`gpt-`, `o1-`, `o3-`,
  `o4-`, `claude-`, `gemini-`, `openrouter/`), because "savings" is
  meaningless for work that was sent to a paid provider.
- `cloud_calls`, `cloud_prompt_tokens`, `cloud_completion_tokens`,
  `cloud_tokens` and the combined `session_*` equivalents — **activity**,
  local + cloud. Added Aug 2026 because the SYSTEM panel read the
  local-only figures and therefore showed zero for a cloud-only session.

`energy_available: false` means this machine has no power-measurement
backend at all (NVIDIA / AMD / Apple / Linux RAPL are the only options), as
opposed to "nothing has run yet". The probe is cached per process because
the panel polls every 3 s.

### Speech
| Endpoint | Shape |
|---|---|
| `POST /v1/speech/transcribe` | multipart `file` (+optional `language`) → `{text, language, confidence, duration_seconds}` |
| `GET /v1/speech/health` | `{available, backend}` |

### Other (upstream)
`/v1/agents`, `/v1/memory` (store/search/index), `/v1/sessions`, `/v1/traces`,
`/v1/skills`, `/v1/budget`, `/v1/feedback`, `/v1/learning`, `/v1/optimize`,
`/health`, websocket bridges.

## 6. Ollama library index (`server/ollama_library.py`)

Ollama publishes **no catalogue API** — `registry.ollama.ai/v2/_catalog` and
`/v2/library/<name>/tags/list` both return 404. The only complete source is
the HTML at `https://ollama.com/library`, so it is fetched and parsed
server-side (the browser cannot: CSP is `default-src 'self'`).

Deliberately defensive, because it is scraping:

- Parses on `/library/<name>` links and the *shape* of size chips
  (`8b`, `1.5b`, `8x7b`) rather than Tailwind class names, which change.
- Caches to `~/.openjarvis/ollama-library.json`; a failed refresh returns
  the last good list with `stale: true` and an `error` string instead of an
  HTTP error, so the tab still works offline.
- The frontend falls back to a 12-item built-in shortlist if there is no
  cache at all.

Each advertised size becomes a pullable tag: `qwen3` + `8b` → `qwen3:8b`.
Verified Aug 2026: 231 models parsed, all with descriptions.

## 7. Model routing rules (cloud_router)

```
model id prefix        → provider
gpt-|o1-|o3-|o4-|chatgpt- → openai
claude-                → anthropic
gemini-                → google
MiniMax-               → minimax
contains "/"           → openrouter        (e.g. meta-llama/llama-3-8b)
mlx-community/ bartowski/ unsloth/ lmstudio-community/ → LOCAL, never cloud
anything else          → local engine (Ollama)
```

## 8. In-app stores

**Frontend** — zustand store (conversations, messages, selected model,
settings, stream state, log entries, `authUser`, `addingAccount`).
localStorage keys:

| Key | Holds |
|---|---|
| `openjarvis-session` | token of the account currently in use |
| `openjarvis-accounts` | `[{token, user}]` — every account signed in on this browser |
| `openjarvis-guest` | `"true"` when using the app with no account |
| `openjarvis-settings` | UI settings |
| `openjarvis-*-key` | UI copies of cloud keys |

Passwords are **never** written to localStorage — only the opaque session
token. Storage keys deliberately kept the `openjarvis-` prefix through the
Vega rename so existing sessions and settings survived.

**Server** — session store (`server/session_store.py`), auth store
(`server/auth_store.py`), and traces/telemetry managed by the Python/Rust
core; treated as opaque — interact via the `/v1/*` APIs rather than files.
