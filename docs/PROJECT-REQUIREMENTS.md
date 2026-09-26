# Vega — Project Requirements Document (PRD)

> Local install at `C:\React_js\Jarvis` — a private build based on upstream
> OpenJarvis v0.1.1 (alpha) plus local changes (see IMPLEMENTATION-PLAN.md
> §Completed). Last updated: 10 Aug 2026.
>
> **Naming:** the product is now called **Vega** everywhere the user can see
> it (tab title, PWA manifest, sign-in screen, chat placeholder, setup
> instructions). The Python package is still `openjarvis` and the data
> directory is still `~/.openjarvis/` — renaming 2,517 import paths and the
> on-disk layout would be a large, breakage-prone refactor for no visible
> gain. Upstream URLs, the macOS `OpenJarvis.app` bundle name and the
> desktop release filenames also keep the original name, because changing
> them would break real links.

## 1. Vision

A **local-first personal AI assistant** that runs on the user's own machine.
Private by default: inference happens on-device through local models
(Ollama), with **optional** cloud models (Gemini/OpenAI/Anthropic/OpenRouter)
used only when the user adds an API key. The system continuously shows the
user what cloud usage *would have cost*, making the value of local inference
visible.

This build additionally guarantees that **nothing about the user leaves the
machine unless the user asks for it** — see §8.

## 2. Goals

| # | Goal | Measure |
|---|------|---------|
| G1 | Answer questions via chat (web UI + CLI) using local models | `jarvis ask`, web chat round-trip works offline |
| G2 | Route each query to the cheapest capable model | Orchestrator picks small local models for trivial queries, larger/cloud for complex |
| G3 | One-click start/stop for non-technical daily use | `start-jarvis.bat` / `stop-jarvis.bat` |
| G4 | Cloud keys managed entirely from the UI | Paste key → models appear → generation works; no file editing |
| G5 | Model lists reflect reality | Cloud lists fetched live per provider; the Ollama Download tab lists the **whole public library**, not a hardcoded shortlist |
| G6 | Voice input | Mic button records, transcribes locally (Whisper), with live preview while speaking |
| G7 | Cost/energy transparency | SYSTEM panel: requests, tokens, power, cost comparison — counting **local and cloud** usage |
| G8 | Local accounts | Sign up / sign in stored on this machine only; multiple accounts; guest mode |
| G9 | No unsolicited network traffic | Nothing contacts the internet unless the user initiates it (§8) |

## 3. Non-goals (current scope)

- No public internet exposure — server binds to localhost.
- No paid-tier management of cloud providers (billing is done in the provider's console).
- Desktop (Tauri) packaging exists upstream but is not part of this install's workflow.
- No password recovery — there is no mail service, so a forgotten password
  means deleting `~/.openjarvis/users.db` and signing up again.
- Accounts are **not** a security boundary against local processes (§8).

> Superseded: "no multi-user accounts" was a non-goal until Aug 2026. The
> app now has local accounts (G8), so that line no longer applies.

## 4. Users

**Primary:** the machine's owner — technically curious, prefers UI over
terminal for daily use (hence the launcher bats and in-UI key management).
Accounts exist for identity and for keeping the app closed to casual access,
not for multi-tenancy.

## 5. Functional requirements

- **FR1 Chat** — streaming chat at `127.0.0.1:8000`, model selectable per conversation; history in the sidebar.
- **FR2 Local models** — any Ollama model on the machine is selectable (qwen3, qwen2.5-coder, etc.).
- **FR3 Cloud models** — per provider: paste key in Cloud Models dialog → key persists server-side → live model list appears → generation works. Remove key → provider disabled.
- **FR4 Voice input** — mic button: record → live text preview every ~1.5 s while speaking → final local transcription on stop. No audio leaves the machine.
- **FR5 Diagnostics** — `jarvis doctor` (run with `PYTHONUTF8=1` on Windows), Logs page, telemetry panel.
- **FR6 Launchers** — `start-jarvis.bat` (frees port, starts Ollama if needed, starts server, opens browser), `stop-jarvis.bat`.
- **FR7 Agents/tools** — orchestrator agent with `code_interpreter`, `web_search`, `file_read`, `shell_exec` (enabled in config). Note `shell_exec` and `file_read` let the model act on this machine — see §7.
- **FR8 Memory (available, not yet used)** — `jarvis memory index <folder>` for local RAG over user documents.
- **FR9 Accounts** — email + password sign-up/sign-in against `~/.openjarvis/users.db`; the UI is gated until signed in. Several accounts may be signed in at once and switched from the sidebar account menu. **"No thanks"** enters guest mode with no account at all.
- **FR10 Model browser** — the Download tab lists every model in Ollama's public library (~231), searchable, with one pull button per published size tag; plus a free-text box for any tag, including community models.

## 6. Constraints

- Windows 11, CPU-only inference (no CUDA) — response latency ~20 s on 7B local models; Whisper `base`/int8 for speech.
- **No power sensor on this machine** — the energy backends are NVIDIA, AMD, Apple and Linux RAPL; none apply to a Windows box with no NVIDIA GPU, so the SYSTEM panel reports Power/Energy as `n/a` by design.
- Python 3.12 (pinned; the Rust extension wheel is cp312).
- Free-tier Gemini: Flash models only; Pro models require billing (429 otherwise).

## 7. Known risks

- Alpha upstream: APIs and config format may change on update; local changes must be re-applied or upstreamed (see IMPLEMENTATION-PLAN.md).
- PWA service worker aggressively caches the UI. A plain reload — even closing the tab — can keep serving the previous bundle. See IMPLEMENTATION-PLAN.md §Working agreements for the cache-clearing snippet.
- The folder is not a git clone — no upstream update path without re-cloning.
- **The account gate is UI-only.** `/v1/*` endpoints are not authenticated, so any process on this machine can call the API directly. Acceptable for a loopback-bound personal tool; not a defence against local malware.
- **Guest mode weakens the gate by design.** Anyone at the keyboard can click "No thanks" and get in.
- `shell_exec` + `code_interpreter` let the selected model run commands and code on this machine. With a cloud model selected, that is a remote service deciding what to execute locally.

## 8. Privacy posture (audited Aug 2026)

What leaves the machine, and when:

| Traffic | Trigger | Contains |
|---|---|---|
| Chat with a cloud model | User selects e.g. `gemini-flash-latest` | **The full message text** and any retrieved data-source snippets |
| Web search | The agent uses the `web_search` tool | The search query (DuckDuckGo; Tavily if a key is set) |
| Model download | User clicks Download / runs `ollama pull` | Nothing but the request |
| Ollama library listing | User opens the Download tab | Nothing but the request |
| Whisper model download | First voice use | Nothing but the request |
| Connectors / channels | Only if the user connects that service | Normal API access to that service |

**Nothing fires automatically.** Verified removed in this build:

- The Supabase "Share Your Savings" leaderboard upload (name, email and usage statistics, every 30 s) — deleted from the browser build, the Tauri build and `api.ts`, along with the embedded Supabase URL and anon key.
- The GitHub update check that ran on every server start — disabled at both the call site and the function, and its cache file removed.

No analytics SDK of any kind is present (checked source and dependencies for
Google Analytics, Sentry, PostHog, Mixpanel, Segment, Amplitude).

Local-only, never transmitted: account email and password hash
(`users.db`), chat history (browser storage), microphone audio
(faster-whisper runs in-process, the speech module contains no upload
code), connector content (`knowledge.db`), telemetry (`telemetry.db`).
