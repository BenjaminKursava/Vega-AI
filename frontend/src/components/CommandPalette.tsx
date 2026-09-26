import { useState, useRef, useEffect } from 'react';
import { Search, Cpu, X, Download, Loader2, Trash2, Check, Cloud, Key, Eye, EyeOff } from 'lucide-react';
import { useAppStore } from '../lib/store';
import { pullModel, deleteModel, fetchModels, preloadModel, isTauri, saveCloudKey, fetchCloudModels, fetchOllamaLibrary, type CloudModelEntry, type OllamaLibraryModel } from '../lib/api';

/**
 * Offline fallback only.
 *
 * The Download tab now lists Ollama's whole library, fetched live via
 * /v1/ollama/library. This shortlist is what it shows when that fetch
 * fails and no cached copy exists yet — e.g. first run with no internet.
 */
const CATALOGUE_MODELS = [
  { id: 'qwen3.5:0.8b', size: '~1 GB', desc: 'Qwen 3.5 0.8B — fast, lightweight' },
  { id: 'qwen3.5:2b', size: '~2.7 GB', desc: 'Qwen 3.5 2B' },
  { id: 'qwen3.5:4b', size: '~3.4 GB', desc: 'Qwen 3.5 4B — recommended default' },
  { id: 'qwen3.5:9b', size: '~6.6 GB', desc: 'Qwen 3.5 9B' },
  { id: 'qwen3.5:27b', size: '~17 GB', desc: 'Qwen 3.5 27B' },
  { id: 'qwen3.5:35b', size: '~24 GB', desc: 'Qwen 3.5 35B' },
  { id: 'qwen3.5:122b', size: '~81 GB', desc: 'Qwen 3.5 122B — largest' },
  { id: 'llama3.3:latest', size: '~4.9 GB', desc: 'Llama 3.3 8B' },
  { id: 'mistral:latest', size: '~4.1 GB', desc: 'Mistral 7B' },
  { id: 'gemma3:latest', size: '~3.3 GB', desc: 'Gemma 3 4B' },
  { id: 'deepseek-r1:7b', size: '~4.7 GB', desc: 'DeepSeek R1 7B' },
  { id: 'phi4:latest', size: '~9.1 GB', desc: 'Phi-4 14B' },
];

/** Cloud provider definitions */
interface CloudProvider {
  name: string;
  envKey: string;
  storageKey: string;
  models: Array<{ id: string; desc: string }>;
}

const CLOUD_PROVIDERS: CloudProvider[] = [
  {
    name: 'OpenAI',
    envKey: 'OPENAI_API_KEY',
    storageKey: 'openjarvis-openai-key',
    models: [
      { id: 'gpt-4o', desc: 'GPT-4o — fast, multimodal' },
      { id: 'gpt-4o-mini', desc: 'GPT-4o Mini — cheap, fast' },
      { id: 'o3-mini', desc: 'o3-mini — reasoning' },
    ],
  },
  {
    name: 'Anthropic',
    envKey: 'ANTHROPIC_API_KEY',
    storageKey: 'openjarvis-anthropic-key',
    models: [
      { id: 'claude-sonnet-4-6', desc: 'Claude Sonnet 4.6 — balanced' },
      { id: 'claude-opus-4-6', desc: 'Claude Opus 4.6 — most capable' },
      { id: 'claude-haiku-4-5', desc: 'Claude Haiku 4.5 — fastest' },
    ],
  },
  {
    name: 'Google',
    envKey: 'GEMINI_API_KEY',
    storageKey: 'openjarvis-gemini-key',
    // Real model IDs per Google's ListModels API (the previous list was
    // aspirational — "gemini-3-pro" does not exist and 404'd; the actual ID
    // is "gemini-3-pro-preview"). The -latest aliases track new releases
    // automatically. Pro models typically 429 on keyless free tier — flash
    // models are the free-tier workhorses.
    models: [
      { id: 'gemini-flash-latest', desc: 'Gemini Flash — always newest, free-tier friendly' },
      { id: 'gemini-3.5-flash', desc: 'Gemini 3.5 Flash — fast' },
      { id: 'gemini-2.5-flash', desc: 'Gemini 2.5 Flash — fast, stable' },
      { id: 'gemini-2.5-flash-lite', desc: 'Gemini 2.5 Flash-Lite — cheapest' },
      { id: 'gemini-pro-latest', desc: 'Gemini Pro — always newest (may need billing)' },
      { id: 'gemini-3.1-pro-preview', desc: 'Gemini 3.1 Pro Preview (may need billing)' },
      { id: 'gemini-2.5-pro', desc: 'Gemini 2.5 Pro (may need billing)' },
    ],
  },
  {
    name: 'OpenRouter',
    envKey: 'OPENROUTER_API_KEY',
    storageKey: 'openjarvis-openrouter-key',
    models: [
      { id: 'openrouter/auto', desc: 'Auto — best model for the task' },
      { id: 'openrouter/anthropic/claude-sonnet-4', desc: 'Claude Sonnet 4 via OpenRouter' },
      { id: 'openrouter/deepseek/deepseek-r1', desc: 'DeepSeek R1 via OpenRouter' },
    ],
  },
];

function getStoredKey(storageKey: string): string {
  try { return localStorage.getItem(storageKey) || ''; } catch { return ''; }
}
function setStoredKey(storageKey: string, value: string): void {
  try {
    if (value) localStorage.setItem(storageKey, value);
    else localStorage.removeItem(storageKey);
  } catch {}
}

type Tab = 'installed' | 'catalogue' | 'cloud';

export function CommandPalette() {
  const [query, setQuery] = useState('');
  const [selectedIdx, setSelectedIdx] = useState(0);
  const [tab, setTab] = useState<Tab>('installed');
  const [pulling, setPulling] = useState<string | null>(null);
  const [pullError, setPullError] = useState<string | null>(null);
  const [pullSuccess, setPullSuccess] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [customModel, setCustomModel] = useState('');
  const [showKeys, setShowKeys] = useState<Record<string, boolean>>({});
  const [apiKeys, setApiKeys] = useState<Record<string, string>>(() => {
    const keys: Record<string, string> = {};
    for (const p of CLOUD_PROVIDERS) keys[p.storageKey] = getStoredKey(p.storageKey);
    return keys;
  });
  // Live model lists keyed by provider name — fetched by the server with the
  // stored key, so the dialog shows what the key can ACTUALLY use. Falls back
  // to the provider's hardcoded list while empty (no key / fetch failed).
  const [liveModels, setLiveModels] = useState<Record<string, CloudModelEntry[]>>({});
  // Ollama's full public library, fetched through our server.
  const [library, setLibrary] = useState<OllamaLibraryModel[] | null>(null);
  const [libraryLoading, setLibraryLoading] = useState(false);
  const [libraryNote, setLibraryNote] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const PROVIDER_SLUGS: Record<string, string> = {
    Google: 'google',
    OpenAI: 'openai',
    Anthropic: 'anthropic',
    OpenRouter: 'openrouter',
  };

  const refreshLiveModels = async (providerName?: string) => {
    const targets = providerName ? [providerName] : Object.keys(PROVIDER_SLUGS);
    await Promise.all(
      targets.map(async (name) => {
        const slug = PROVIDER_SLUGS[name];
        if (!slug) return;
        const list = await fetchCloudModels(slug);
        setLiveModels((prev) => ({ ...prev, [name]: list }));
      })
    );
  };

  const models = useAppStore((s) => s.models);
  const selectedModel = useAppStore((s) => s.selectedModel);
  const setSelectedModel = useAppStore((s) => s.setSelectedModel);
  const setModels = useAppStore((s) => s.setModels);
  const setCommandPaletteOpen = useAppStore((s) => s.setCommandPaletteOpen);

  const installedIds = new Set(models.map((m) => m.id));

  // The catalogue is the live library when we have it, otherwise the
  // built-in shortlist reshaped to match so the render path is identical.
  const catalogue: OllamaLibraryModel[] =
    library ??
    CATALOGUE_MODELS.map((m) => ({
      name: m.id.split(':')[0],
      description: m.desc,
      sizes: [],
      capabilities: [],
      tags: [m.id.includes(':') ? m.id.split(':')[1] : 'latest'],
    }));

  const q = query.trim().toLowerCase();
  const catalogueMatches = catalogue.filter(
    (m) =>
      !q ||
      m.name.toLowerCase().includes(q) ||
      m.description.toLowerCase().includes(q) ||
      m.capabilities.some((c) => c.includes(q)),
  );

  const filtered = tab === 'installed'
    ? (query
        ? models.filter((m) => m.id.toLowerCase().includes(query.toLowerCase()))
        : models)
    : tab === 'catalogue'
    ? catalogueMatches
    : []; // cloud tab doesn't use filtered

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  // Fetch the live cloud-model list whenever the Cloud tab is shown.
  useEffect(() => {
    if (tab === 'cloud') {
      refreshLiveModels();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab]);

  // Fetch Ollama's full library the first time the Download tab is opened.
  // The server caches it, so this is cheap on every subsequent open.
  useEffect(() => {
    if (tab !== 'catalogue' || library || libraryLoading) return;
    setLibraryLoading(true);
    fetchOllamaLibrary()
      .then((res) => {
        if (res.models.length > 0) setLibrary(res.models);
        setLibraryNote(
          res.error
            ? res.models.length > 0
              ? 'Showing a cached copy — could not reach ollama.com.'
              : 'Could not reach ollama.com. Showing built-in suggestions.'
            : null,
        );
      })
      .catch(() =>
        setLibraryNote('Could not load the library. Showing built-in suggestions.'),
      )
      .finally(() => setLibraryLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab]);

  useEffect(() => {
    setSelectedIdx(0);
  }, [query, tab]);

  useEffect(() => {
    if (pullSuccess) {
      const t = setTimeout(() => setPullSuccess(null), 3000);
      return () => clearTimeout(t);
    }
  }, [pullSuccess]);

  const handleSelect = async (modelId: string) => {
    const previousModel = selectedModel;
    setSelectedModel(modelId);
    setCommandPaletteOpen(false);

    if (modelId !== previousModel) {
      const { createConversation, setModelLoading, addLogEntry } = useAppStore.getState();
      createConversation(modelId);
      setModelLoading(true);
      addLogEntry({ timestamp: Date.now(), level: 'info', category: 'model', message: `Switching to ${modelId}...` });
      try {
        await preloadModel(modelId);
        addLogEntry({ timestamp: Date.now(), level: 'info', category: 'model', message: `${modelId} loaded` });
      } catch (e: any) {
        addLogEntry({ timestamp: Date.now(), level: 'error', category: 'model', message: `Failed to load ${modelId}: ${e.message}` });
      } finally {
        setModelLoading(false);
      }
    }
  };

  const refreshModels = async () => {
    try {
      const m = await fetchModels();
      setModels(m);
    } catch {}
  };

  const handlePull = async (modelId: string) => {
    setPulling(modelId);
    setPullError(null);
    try {
      await pullModel(modelId);
      setPullSuccess(modelId);
      useAppStore.getState().addLogEntry({
        timestamp: Date.now(), level: 'info', category: 'model',
        message: `Downloaded ${modelId}`,
      });
      await refreshModels();
      setSelectedModel(modelId);
    } catch (e: any) {
      setPullError(e.message || 'Download failed');
      useAppStore.getState().addLogEntry({
        timestamp: Date.now(), level: 'error', category: 'model',
        message: `Download failed for ${modelId}: ${e.message}`,
      });
    } finally {
      setPulling(null);
    }
  };

  const handleDelete = async (modelId: string) => {
    setDeleting(modelId);
    try {
      await deleteModel(modelId);
      useAppStore.getState().addLogEntry({
        timestamp: Date.now(), level: 'info', category: 'model',
        message: `Deleted ${modelId}`,
      });
      await refreshModels();
      if (selectedModel === modelId) {
        const remaining = models.filter((m) => m.id !== modelId);
        if (remaining.length > 0) setSelectedModel(remaining[0].id);
      }
    } catch {} finally {
      setDeleting(null);
    }
  };

  const handleCustomPull = async () => {
    const name = customModel.trim();
    if (!name) return;
    await handlePull(name);
    setCustomModel('');
  };

  const handleSaveKey = async (provider: CloudProvider, value: string) => {
    setStoredKey(provider.storageKey, value);
    setApiKeys((prev) => ({ ...prev, [provider.storageKey]: value }));

    // Persist to the local API server (writes ~/.openjarvis/cloud-keys.env,
    // re-read on every request). Generation runs SERVER-side — before this
    // call, a key saved in a plain browser lived only in localStorage and
    // cloud models failed with "GEMINI_API_KEY not set".
    try {
      await saveCloudKey(provider.envKey, value);
    } catch {}

    // Key changed → the set of usable models changed with it.
    if (PROVIDER_SLUGS[provider.name]) {
      refreshLiveModels(provider.name);
    }

    // Also save to Tauri backend so the server process picks up the key
    if (isTauri()) {
      try {
        const { invoke } = await import('@tauri-apps/api/core');
        await invoke('save_cloud_key', { keyName: provider.envKey, keyValue: value });
      } catch {}
    }

    useAppStore.getState().addLogEntry({
      timestamp: Date.now(), level: 'info', category: 'model',
      message: `${provider.name} API key ${value ? 'saved' : 'removed'}. Refreshing model list…`,
    });

    // Refresh the model list so cloud models appear immediately.
    await refreshModels();
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      setCommandPaletteOpen(false);
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      setSelectedIdx((i) => Math.min(i + 1, filtered.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setSelectedIdx((i) => Math.max(i - 1, 0));
    } else if (e.key === 'Enter' && tab === 'installed' && filtered.length > 0) {
      e.preventDefault();
      handleSelect((filtered[selectedIdx] as any).id);
    }
  };

  const TAB_LABELS: Record<Tab, string> = {
    installed: `Installed Models (${models.length})`,
    catalogue: 'Download',
    cloud: 'Cloud Models',
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center pt-[15vh]"
      onClick={() => setCommandPaletteOpen(false)}
    >
      <div className="fixed inset-0" style={{ background: 'rgba(0,0,0,0.5)' }} />

      <div
        className="relative w-full max-w-lg rounded-xl overflow-hidden"
        style={{
          background: 'var(--color-surface)',
          border: '1px solid var(--color-border)',
          boxShadow: 'var(--shadow-lg)',
        }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Tabs */}
        <div className="flex" style={{ borderBottom: '1px solid var(--color-border)' }}>
          {(['installed', 'catalogue', 'cloud'] as Tab[]).map((t) => (
            <button
              key={t}
              onClick={() => setTab(t)}
              className="flex-1 px-3 py-2.5 text-xs font-medium transition-colors cursor-pointer"
              style={{
                color: tab === t ? 'var(--color-accent)' : 'var(--color-text-tertiary)',
                borderBottom: tab === t ? '2px solid var(--color-accent)' : '2px solid transparent',
                background: 'transparent',
              }}
            >
              {TAB_LABELS[t]}
            </button>
          ))}
        </div>

        {/* Search (not for cloud tab) */}
        {tab !== 'cloud' && (
          <div
            className="flex items-center gap-3 px-4 py-3"
            style={{ borderBottom: '1px solid var(--color-border)' }}
          >
            <Search size={18} style={{ color: 'var(--color-text-tertiary)' }} />
            <input
              ref={inputRef}
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder={tab === 'installed' ? 'Search installed models...' : 'Search models to download...'}
              className="flex-1 bg-transparent outline-none text-sm"
              style={{ color: 'var(--color-text)' }}
            />
            <button
              onClick={() => setCommandPaletteOpen(false)}
              className="p-1 rounded cursor-pointer"
              style={{ color: 'var(--color-text-tertiary)' }}
            >
              <X size={16} />
            </button>
          </div>
        )}

        {/* Status messages */}
        {pullError && (
          <div className="px-4 py-2 text-xs" style={{ color: 'var(--color-error)', background: 'rgba(220,38,38,0.05)' }}>
            {pullError}
          </div>
        )}
        {pullSuccess && (
          <div className="px-4 py-2 text-xs flex items-center gap-1.5" style={{ color: 'var(--color-success)', background: 'color-mix(in srgb, var(--color-success) 5%, transparent)' }}>
            <Check size={12} /> Downloaded {pullSuccess} successfully
          </div>
        )}

        {/* Results */}
        <div className="max-h-[400px] overflow-y-auto py-2">
          {tab === 'installed' ? (
            filtered.length === 0 ? (
              <div className="px-4 py-6 text-center text-sm" style={{ color: 'var(--color-text-tertiary)' }}>
                {models.length === 0
                  ? 'No models available — switch to "Download" to get started'
                  : 'No matching models'}
              </div>
            ) : (
              (filtered as typeof models).map((model, idx) => {
                const isActive = model.id === selectedModel;
                const isSelected = idx === selectedIdx;
                const isDeleting = deleting === model.id;
                return (
                  <div
                    key={model.id}
                    className="flex items-center gap-3 w-full px-4 py-2.5 transition-colors"
                    style={{ background: isSelected ? 'var(--color-bg-secondary)' : 'transparent' }}
                    onMouseEnter={() => setSelectedIdx(idx)}
                  >
                    <button
                      onClick={() => handleSelect(model.id)}
                      className="flex items-center gap-3 flex-1 min-w-0 text-left cursor-pointer"
                      style={{ background: 'none', border: 'none', padding: 0 }}
                    >
                      <Cpu size={16} style={{ color: isActive ? 'var(--color-accent)' : 'var(--color-text-tertiary)' }} />
                      <div className="flex-1 min-w-0">
                        <div className="text-sm truncate" style={{ color: isActive ? 'var(--color-accent)' : 'var(--color-text)', fontWeight: isActive ? 500 : 400 }}>
                          {model.id}
                        </div>
                      </div>
                      {isActive && (
                        <span className="text-[10px] px-2 py-0.5 rounded-full" style={{ background: 'var(--color-accent-subtle)', color: 'var(--color-accent)' }}>
                          Active
                        </span>
                      )}
                    </button>
                    <button
                      onClick={() => handleDelete(model.id)}
                      disabled={isDeleting}
                      className="p-1 rounded transition-colors cursor-pointer"
                      style={{ color: 'var(--color-text-tertiary)', opacity: 0 }}
                      title="Delete model"
                      onMouseEnter={(e) => { e.currentTarget.style.opacity = '1'; e.currentTarget.style.color = 'var(--color-error)'; }}
                      onMouseLeave={(e) => { e.currentTarget.style.opacity = '0'; e.currentTarget.style.color = 'var(--color-text-tertiary)'; }}
                    >
                      {isDeleting ? <Loader2 size={14} className="animate-spin" /> : <Trash2 size={14} />}
                    </button>
                  </div>
                );
              })
            )
          ) : tab === 'catalogue' ? (
            <>
              {libraryLoading && !library && (
                <div className="flex items-center gap-2 px-4 py-3 text-[12px]" style={{ color: 'var(--color-text-tertiary)' }}>
                  <Loader2 size={13} className="animate-spin" /> Loading Ollama's model library…
                </div>
              )}
              {libraryNote && (
                <div className="px-4 py-2 text-[11px]" style={{ color: 'var(--color-text-tertiary)' }}>
                  {libraryNote}
                </div>
              )}
              {library && !libraryLoading && (
                <div className="px-4 py-2 text-[11px] flex items-center gap-2" style={{ color: 'var(--color-text-tertiary)' }}>
                  <span>
                    {catalogueMatches.length} of {library.length} models
                    {query ? ` matching "${query}"` : ' in the Ollama library'}
                  </span>
                  <button
                    onClick={() => {
                      // Bypass the 6-hour server cache — for when a model
                      // was published since the list was last fetched.
                      setLibraryLoading(true);
                      fetchOllamaLibrary(true)
                        .then((res) => {
                          if (res.models.length > 0) setLibrary(res.models);
                          setLibraryNote(res.error ? 'Refresh failed — showing the cached list.' : null);
                        })
                        .catch(() => setLibraryNote('Refresh failed — showing the cached list.'))
                        .finally(() => setLibraryLoading(false));
                    }}
                    className="underline cursor-pointer"
                    style={{ color: 'var(--color-text-tertiary)' }}
                  >
                    Refresh
                  </button>
                </div>
              )}
              {library && catalogueMatches.length === 0 && (
                <div className="px-4 py-3 text-[12px]" style={{ color: 'var(--color-text-tertiary)' }}>
                  No model in Ollama's library matches "{query}". If you know the exact
                  tag, use the box below.
                </div>
              )}

              {(filtered as OllamaLibraryModel[]).map((model) => {
                // Each advertised size is a real pullable tag: "llama3.3" +
                // "70b" -> "llama3.3:70b". Embedding models list no sizes,
                // so they only offer ":latest".
                const tags = model.tags.length > 0 ? model.tags : ['latest'];
                return (
                  <div key={model.name} className="flex items-start gap-3 w-full px-4 py-2.5">
                    <Download size={16} className="mt-0.5 shrink-0" style={{ color: 'var(--color-text-tertiary)' }} />
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-1.5 flex-wrap">
                        <span className="text-sm" style={{ color: 'var(--color-text)' }}>{model.name}</span>
                        {model.capabilities.map((cap) => (
                          <span
                            key={cap}
                            className="text-[9px] px-1.5 py-0.5 rounded"
                            style={{ background: 'var(--color-bg-secondary)', color: 'var(--color-text-tertiary)' }}
                          >
                            {cap}
                          </span>
                        ))}
                      </div>
                      {model.description && (
                        <div className="text-[11px] mt-0.5" style={{ color: 'var(--color-text-tertiary)' }}>
                          {model.description}
                        </div>
                      )}
                      <div className="flex items-center gap-1.5 flex-wrap mt-1.5">
                        {tags.map((tag) => {
                          const fullId = `${model.name}:${tag}`;
                          const installed = installedIds.has(fullId);
                          const isPulling = pulling === fullId;
                          const justInstalled = pullSuccess === fullId;
                          return (
                            <button
                              key={tag}
                              onClick={() => !installed && handlePull(fullId)}
                              disabled={installed || !!pulling}
                              title={installed ? `${fullId} is already installed` : `Download ${fullId}`}
                              className="flex items-center gap-1 px-2 py-0.5 rounded-md text-[11px] font-medium cursor-pointer"
                              style={{
                                background: installed || justInstalled
                                  ? 'var(--color-accent-subtle)'
                                  : 'var(--color-bg-secondary)',
                                color: installed || justInstalled
                                  ? 'var(--color-accent)'
                                  : 'var(--color-text-secondary)',
                                border: '1px solid var(--color-border)',
                                opacity: pulling && !isPulling ? 0.5 : 1,
                              }}
                            >
                              {isPulling ? <Loader2 size={10} className="animate-spin" /> :
                               (installed || justInstalled) ? <Check size={10} /> :
                               <Download size={10} />}
                              {tag}
                            </button>
                          );
                        })}
                      </div>
                    </div>
                  </div>
                );
              })}
              <div className="px-4 py-3 mt-1" style={{ borderTop: '1px solid var(--color-border)' }}>
                <div className="text-[11px] mb-2" style={{ color: 'var(--color-text-tertiary)' }}>Or enter any Ollama model name:</div>
                <div className="flex gap-2">
                  <input
                    type="text" value={customModel}
                    onChange={(e) => setCustomModel(e.target.value)}
                    onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); handleCustomPull(); } }}
                    placeholder="e.g. codellama:7b"
                    className="flex-1 text-sm px-3 py-1.5 rounded-lg outline-none"
                    style={{ background: 'var(--color-bg-secondary)', color: 'var(--color-text)', border: '1px solid var(--color-border)' }}
                  />
                  <button
                    onClick={handleCustomPull} disabled={!customModel.trim() || !!pulling}
                    className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium cursor-pointer"
                    style={{ background: 'var(--color-accent)', color: 'var(--color-on-accent)', opacity: (!customModel.trim() || pulling) ? 0.5 : 1 }}
                  >
                    <Download size={12} /> Pull
                  </button>
                </div>
              </div>
            </>
          ) : (
            /* ── Cloud Models tab ── */
            <div className="px-4 py-2">
              <div className="text-[11px] mb-3" style={{ color: 'var(--color-text-tertiary)' }}>
                Add your API keys to use cloud models. Keys are stored locally on your device only.
              </div>

              {CLOUD_PROVIDERS.map((provider) => {
                const key = apiKeys[provider.storageKey] || '';
                const hasKey = !!key;
                const isVisible = showKeys[provider.storageKey];

                return (
                  <div key={provider.name} className="mb-4">
                    <div className="flex items-center gap-2 mb-2">
                      <Cloud size={14} style={{ color: hasKey ? 'var(--color-success)' : 'var(--color-text-tertiary)' }} />
                      <span className="text-xs font-medium" style={{ color: 'var(--color-text)' }}>{provider.name}</span>
                      {hasKey && (
                        <span className="text-[10px] px-1.5 py-0.5 rounded-full" style={{ background: 'color-mix(in srgb, var(--color-success) 10%, transparent)', color: 'var(--color-success)' }}>
                          Connected
                        </span>
                      )}
                    </div>

                    {/* API key input */}
                    <div className="flex gap-1.5 mb-2">
                      <div className="flex-1 flex items-center rounded-lg" style={{ background: 'var(--color-bg-secondary)', border: '1px solid var(--color-border)' }}>
                        <Key size={12} className="ml-2.5 shrink-0" style={{ color: 'var(--color-text-tertiary)' }} />
                        <input
                          type={isVisible ? 'text' : 'password'}
                          value={key}
                          onChange={(e) => setApiKeys((prev) => ({ ...prev, [provider.storageKey]: e.target.value }))}
                          onBlur={() => handleSaveKey(provider, apiKeys[provider.storageKey] || '')}
                          placeholder={`${provider.envKey}`}
                          className="flex-1 text-xs px-2 py-1.5 bg-transparent outline-none font-mono"
                          style={{ color: 'var(--color-text)' }}
                        />
                        <button
                          onClick={() => setShowKeys((prev) => ({ ...prev, [provider.storageKey]: !prev[provider.storageKey] }))}
                          className="px-2 cursor-pointer" style={{ color: 'var(--color-text-tertiary)' }}
                        >
                          {isVisible ? <EyeOff size={12} /> : <Eye size={12} />}
                        </button>
                      </div>
                      {hasKey && (
                        <button
                          onClick={() => handleSaveKey(provider, '')}
                          className="px-2 py-1 rounded-lg text-[10px] cursor-pointer"
                          style={{ color: 'var(--color-error)', border: '1px solid var(--color-error)' }}
                        >
                          Remove
                        </button>
                      )}
                    </div>

                    {/* Models for this provider (only show if key is set).
                        Live server-fetched list when available; the hardcoded
                        provider.models array is only the offline fallback. */}
                    {hasKey && (
                      <div className="ml-5 flex flex-col gap-1">
                        {(liveModels[provider.name]?.length ? liveModels[provider.name] : provider.models).map((model) => {
                          const isActive = model.id === selectedModel;
                          return (
                            <button
                              key={model.id}
                              onClick={() => handleSelect(model.id)}
                              className="flex items-center gap-2 px-2.5 py-1.5 rounded-lg text-left cursor-pointer transition-colors"
                              style={{ background: isActive ? 'var(--color-accent-subtle)' : 'transparent' }}
                              onMouseEnter={(e) => { if (!isActive) e.currentTarget.style.background = 'var(--color-bg-secondary)'; }}
                              onMouseLeave={(e) => { if (!isActive) e.currentTarget.style.background = 'transparent'; }}
                            >
                              <Cloud size={12} style={{ color: isActive ? 'var(--color-accent)' : 'var(--color-text-tertiary)' }} />
                              <div className="flex-1 min-w-0">
                                <div className="text-xs truncate" style={{ color: isActive ? 'var(--color-accent)' : 'var(--color-text)', fontWeight: isActive ? 500 : 400 }}>
                                  {model.id}
                                </div>
                                <div className="text-[10px] truncate" style={{ color: 'var(--color-text-tertiary)' }}>
                                  {model.desc}
                                </div>
                              </div>
                              {isActive && (
                                <span className="text-[9px] px-1.5 py-0.5 rounded-full shrink-0" style={{ background: 'var(--color-accent-subtle)', color: 'var(--color-accent)' }}>
                                  Active
                                </span>
                              )}
                            </button>
                          );
                        })}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* Footer */}
        <div
          className="flex items-center gap-4 px-4 py-2 text-[11px]"
          style={{ borderTop: '1px solid var(--color-border)', color: 'var(--color-text-tertiary)' }}
        >
          {tab === 'installed' ? (
            <>
              <span><kbd className="font-mono">↑↓</kbd> Navigate</span>
              <span><kbd className="font-mono">Enter</kbd> Select</span>
              <span><kbd className="font-mono">Esc</kbd> Close</span>
            </>
          ) : tab === 'catalogue' ? (
            <span>Models are downloaded from the Ollama registry</span>
          ) : (
            <span>API keys are stored locally and never sent to Vega servers</span>
          )}
        </div>
      </div>
    </div>
  );
}
