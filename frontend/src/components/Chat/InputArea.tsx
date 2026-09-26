import { useState, useRef, useCallback, useEffect } from 'react';
import { Send, Square, Paperclip, X, FileText } from 'lucide-react';
import { useAppStore, generateId } from '../../lib/store';
import { streamChat } from '../../lib/sse';
import { fetchSavings, getBase } from '../../lib/api';
import {
  filesToAttachments,
  dataUrlToBase64,
  attachmentPromptBlock,
  MAX_ATTACHMENTS,
} from '../../lib/attachments';
import { MicButton } from './MicButton';
import { useSpeech } from '../../hooks/useSpeech';
import type { ChatMessage, ToolCallInfo, TokenUsage, MessageTelemetry, Attachment } from '../../types';

// Models routed to cloud providers — used for the telemetry engine label and
// to warn that image attachments are only read by local (Ollama) vision models.
const CLOUD_PREFIXES = ['gpt-', 'o1-', 'o3-', 'o4-', 'claude-', 'gemini-', 'openrouter/', 'MiniMax-', 'chatgpt-'];

const FILE_INPUT_ACCEPT =
  'image/*,.txt,.md,.markdown,.csv,.tsv,.json,.xml,.yml,.yaml,.log,.ini,.toml,.conf,' +
  '.js,.jsx,.ts,.tsx,.py,.php,.html,.css,.scss,.sql,.sh,.bat,.ps1,.rs,.go,.java,.c,.cpp,.h';

export function InputArea() {
  const [input, setInput] = useState('');
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [attachmentNote, setAttachmentNote] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const activeId = useAppStore((s) => s.activeId);
  const selectedModel = useAppStore((s) => s.selectedModel);
  const streamState = useAppStore((s) => s.streamState);
  const messages = useAppStore((s) => s.messages);
  const speechEnabled = useAppStore((s) => s.settings.speechEnabled);
  const maxTokens = useAppStore((s) => s.settings.maxTokens);
  const temperature = useAppStore((s) => s.settings.temperature);
  const createConversation = useAppStore((s) => s.createConversation);
  const addMessage = useAppStore((s) => s.addMessage);
  const updateLastAssistant = useAppStore((s) => s.updateLastAssistant);
  const setStreamState = useAppStore((s) => s.setStreamState);
  const resetStream = useAppStore((s) => s.resetStream);
  const modelLoading = useAppStore((s) => s.modelLoading);

  const { state: speechState, available: speechAvailable, startRecording, stopRecording } = useSpeech();

  // Abort in-flight stream when the user switches models mid-generation.
  // This prevents errors from trying to continue a stream with a stale model.
  const prevModelRef = useRef(selectedModel);
  useEffect(() => {
    if (prevModelRef.current !== selectedModel && streamState.isStreaming) {
      abortRef.current?.abort();
      if (timerRef.current) {
        clearInterval(timerRef.current);
        timerRef.current = null;
      }
      resetStream();
      abortRef.current = null;
    }
    prevModelRef.current = selectedModel;
  }, [selectedModel, streamState.isStreaming, resetStream]);

  const micDisabled = !speechEnabled || !speechAvailable || streamState.isStreaming;
  const micReason: 'not-enabled' | 'no-backend' | 'streaming' | undefined =
    !speechEnabled ? 'not-enabled'
    : !speechAvailable ? 'no-backend'
    : streamState.isStreaming ? 'streaming'
    : undefined;

  // Whatever was typed BEFORE recording started — live previews and the
  // final transcription always replace only the dictated part after it,
  // never each other cumulatively.
  const dictationBaseRef = useRef('');

  const handleMicClick = useCallback(async () => {
    if (speechState === 'recording') {
      try {
        const text = await stopRecording();
        const base = dictationBaseRef.current;
        // Replace (not append): the field may already hold the live preview.
        if (text || base) {
          setInput(base && text ? base + ' ' + text : base || text);
        }
      } catch {
        // Error is captured in useSpeech
      }
    } else {
      dictationBaseRef.current = input;
      await startRecording((interim) => {
        const base = dictationBaseRef.current;
        setInput(base ? base + ' ' + interim : interim);
      });
    }
  }, [speechState, startRecording, stopRecording, input]);

  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = Math.min(el.scrollHeight, 200) + 'px';
  }, [input]);

  const stopStreaming = useCallback(() => {
    abortRef.current?.abort();
    if (timerRef.current) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
    resetStream();
  }, [resetStream]);

  const addFiles = useCallback(
    async (files: File[]) => {
      const { attachments: added, rejected } = await filesToAttachments(files, attachments.length);
      if (added.length) setAttachments((prev) => [...prev, ...added]);
      setAttachmentNote(rejected.length ? rejected.join(' · ') : null);
    },
    [attachments.length],
  );

  const handleFileInput = useCallback(
    async (e: React.ChangeEvent<HTMLInputElement>) => {
      const files = e.target.files;
      if (files && files.length) await addFiles(Array.from(files));
      e.target.value = ''; // allow re-selecting the same file
    },
    [addFiles],
  );

  const handlePaste = useCallback(
    async (e: React.ClipboardEvent) => {
      const files = Array.from(e.clipboardData?.files ?? []);
      if (files.length) {
        e.preventDefault();
        await addFiles(files);
      }
    },
    [addFiles],
  );

  const removeAttachment = useCallback((id: string) => {
    setAttachments((prev) => prev.filter((a) => a.id !== id));
  }, []);

  const sendMessage = useCallback(async () => {
    const content = input.trim();
    if ((!content && attachments.length === 0) || streamState.isStreaming) return;

    const outgoingAttachments = attachments;
    setInput('');
    setAttachments([]);
    setAttachmentNote(null);

    let convId = activeId;
    if (!convId) {
      convId = createConversation(selectedModel);
    }

    const userMsg: ChatMessage = {
      id: generateId(),
      role: 'user',
      content,
      timestamp: Date.now(),
      attachments: outgoingAttachments.length ? outgoingAttachments : undefined,
    };
    addMessage(convId, userMsg);

    // Build API messages before adding assistant placeholder.
    // Image attachments travel as base64 in `images` (read by local vision
    // models); text attachments are inlined into the prompt content — the
    // stored message keeps only the chip, the model sees the full file.
    const currentMessages = useAppStore.getState().messages;
    const apiMessages = currentMessages.map((m) => {
      let text = m.content;
      const images: string[] = [];
      for (const a of m.attachments ?? []) {
        if (a.kind === 'image' && a.dataUrl) {
          images.push(dataUrlToBase64(a.dataUrl));
        } else if (a.kind === 'text' && a.text) {
          text += attachmentPromptBlock(a);
        }
      }
      const apiMsg: { role: string; content: string; images?: string[] } = {
        role: m.role,
        content: text,
      };
      if (images.length) apiMsg.images = images;
      return apiMsg;
    });

    const assistantMsg: ChatMessage = {
      id: generateId(),
      role: 'assistant',
      content: '',
      timestamp: Date.now(),
    };
    addMessage(convId, assistantMsg);

    // Start streaming
    const startTime = Date.now();
    const timer = setInterval(() => {
      setStreamState({ elapsedMs: Date.now() - startTime });
    }, 100);
    timerRef.current = timer;

    const controller = new AbortController();
    abortRef.current = controller;

    let accumulatedContent = '';
    let usage: TokenUsage | undefined;
    let complexity: { score: number; tier: string; suggested_max_tokens: number } | undefined;
    const toolCalls: ToolCallInfo[] = [];
    let lastFlush = 0;
    let ttftMs: number | undefined;

    setStreamState({
      isStreaming: true,
      phase: 'Generating...',
      elapsedMs: 0,
      activeToolCalls: [],
      content: '',
    });
    useAppStore.getState().addLogEntry({
      timestamp: Date.now(),
      level: 'info',
      category: 'chat',
      message: `Request: "${content.slice(0, 80)}${content.length > 80 ? '...' : ''}" → ${selectedModel}`,
    });

    try {
      for await (const sseEvent of streamChat(
        { model: selectedModel, messages: apiMessages, stream: true, temperature, max_tokens: maxTokens },
        controller.signal,
      )) {
        const eventName = sseEvent.event;

        if (eventName === 'agent_turn_start') {
          setStreamState({ phase: 'Agent thinking...' });
        } else if (eventName === 'inference_start') {
          setStreamState({ phase: 'Generating...' });
          useAppStore.getState().addLogEntry({
            timestamp: Date.now(), level: 'info', category: 'chat',
            message: `Generating with ${selectedModel}...`,
          });
        } else if (eventName === 'tool_call_start') {
          try {
            const data = JSON.parse(sseEvent.data);
            const tc: ToolCallInfo = {
              id: generateId(),
              tool: data.tool,
              arguments: data.arguments || '',
              status: 'running',
            };
            toolCalls.push(tc);
            setStreamState({
              phase: `Calling ${data.tool}...`,
              activeToolCalls: [...toolCalls],
            });
            updateLastAssistant(convId, accumulatedContent, [...toolCalls]);
            useAppStore.getState().addLogEntry({
              timestamp: Date.now(), level: 'info', category: 'tool',
              message: `Calling ${data.tool}(${data.arguments || ''})`,
            });
          } catch {}
        } else if (eventName === 'tool_call_end') {
          try {
            const data = JSON.parse(sseEvent.data);
            const tc = toolCalls.find(
              (t) => t.tool === data.tool && t.status === 'running',
            );
            if (tc) {
              tc.status = data.success ? 'success' : 'error';
              tc.latency = data.latency;
              tc.result = data.result;
            }
            setStreamState({
              phase: 'Generating...',
              activeToolCalls: [...toolCalls],
            });
            updateLastAssistant(convId, accumulatedContent, [...toolCalls]);
          } catch {}
        } else {
          try {
            const data = JSON.parse(sseEvent.data);
            const delta = data.choices?.[0]?.delta;
            if (data.usage) usage = data.usage;
            if (data.complexity) complexity = data.complexity;
            if (delta?.content) {
              if (!ttftMs) ttftMs = Date.now() - startTime;
              accumulatedContent += delta.content;
              setStreamState({ content: accumulatedContent, phase: '' });

              const now = Date.now();
              if (now - lastFlush >= 80) {
                updateLastAssistant(
                  convId,
                  accumulatedContent,
                  toolCalls.length > 0 ? [...toolCalls] : undefined,
                );
                lastFlush = now;
              }
            }
            if (data.choices?.[0]?.finish_reason === 'stop') break;
          } catch {}
        }
      }
    } catch (err: any) {
      if (err.name === 'AbortError') {
        // User cancelled or model switch — keep whatever was accumulated
        if (!accumulatedContent) accumulatedContent = '(Generation stopped)';
      } else {
        const errMsg = err?.message || String(err);
        accumulatedContent =
          accumulatedContent || `Error: ${errMsg}`;
        useAppStore.getState().addLogEntry({
          timestamp: Date.now(), level: 'error', category: 'chat',
          message: `Stream error: ${errMsg}`,
        });
      }
    } finally {
      if (!accumulatedContent) {
        accumulatedContent = 'No response was generated. Please try again.';
      }
      const totalMs = Date.now() - startTime;
      const engineLabel = CLOUD_PREFIXES.some(p => selectedModel.startsWith(p)) ? 'cloud' : 'ollama';
      const telemetry: MessageTelemetry = {
        engine: engineLabel,
        model_id: selectedModel,
        total_ms: totalMs,
        ttft_ms: ttftMs,
        tokens_per_sec: usage?.completion_tokens
          ? usage.completion_tokens / (totalMs / 1000)
          : undefined,
        complexity_score: complexity?.score,
        complexity_tier: complexity?.tier,
        suggested_max_tokens: complexity?.suggested_max_tokens,
      };
      // Check if the response has digest audio available
      let audioMeta: { url: string } | undefined;
      try {
        const digestRes = await fetch(`${getBase()}/api/digest`);
        if (digestRes.ok) {
          const digest = await digestRes.json();
          if (digest.audio_available) {
            audioMeta = { url: `${getBase()}/api/digest/audio` };
          }
        }
      } catch {
        // Not a digest response or server unavailable — skip
      }

      updateLastAssistant(
        convId,
        accumulatedContent,
        toolCalls.length > 0 ? toolCalls : undefined,
        usage,
        telemetry,
        audioMeta,
      );
      if (timerRef.current) {
        clearInterval(timerRef.current);
        timerRef.current = null;
      }
      resetStream();
      useAppStore.getState().addLogEntry({
        timestamp: Date.now(), level: 'info', category: 'chat',
        message: `Response: ${accumulatedContent.length} chars`,
      });
      abortRef.current = null;

      fetchSavings()
        .then((data) => useAppStore.getState().setSavings(data))
        .catch(() => {});
    }
  }, [
    input,
    attachments,
    activeId,
    selectedModel,
    streamState.isStreaming,
    createConversation,
    addMessage,
    updateLastAssistant,
    setStreamState,
    resetStream,
  ]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  };

  const canSend = !!input.trim() || attachments.length > 0;
  const hasImageAttachment = attachments.some((a) => a.kind === 'image');
  // Gemini receives images (native multimodal support server-side);
  // other cloud providers still get text only.
  const isImageBlindCloudModel =
    CLOUD_PREFIXES.some((p) => selectedModel.startsWith(p)) && !selectedModel.startsWith('gemini-');

  return (
    <div className="px-4 pb-4 pt-2" style={{ maxWidth: 'var(--chat-max-width)', margin: '0 auto', width: '100%' }}>
      <div
        className="rounded-2xl px-4 py-3 transition-shadow"
        style={{
          background: 'var(--color-input-bg)',
          border: '1px solid var(--color-input-border)',
          boxShadow: 'var(--shadow-sm)',
        }}
      >
        {attachments.length > 0 && (
          <div className="flex flex-wrap gap-2 mb-2">
            {attachments.map((a) => (
              <div key={a.id} className="relative">
                {a.kind === 'image' && a.dataUrl ? (
                  <img
                    src={a.dataUrl}
                    alt={a.name}
                    title={a.name}
                    className="h-12 w-12 object-cover rounded-lg"
                    style={{ border: '1px solid var(--color-input-border)' }}
                  />
                ) : (
                  <div
                    className="flex items-center gap-1.5 h-12 px-3 rounded-lg text-xs"
                    style={{
                      background: 'var(--color-bg-tertiary)',
                      color: 'var(--color-text-secondary)',
                      border: '1px solid var(--color-input-border)',
                    }}
                  >
                    <FileText size={14} />
                    <span className="max-w-[140px] truncate">{a.name}</span>
                    <span style={{ color: 'var(--color-text-tertiary)' }}>
                      {Math.max(1, Math.round(a.size / 1024))} KB
                    </span>
                  </div>
                )}
                <button
                  onClick={() => removeAttachment(a.id)}
                  className="absolute -top-1.5 -right-1.5 rounded-full p-0.5 cursor-pointer"
                  style={{
                    background: 'var(--color-bg-tertiary)',
                    color: 'var(--color-text-secondary)',
                    border: '1px solid var(--color-input-border)',
                  }}
                  title={`Remove ${a.name}`}
                >
                  <X size={10} />
                </button>
              </div>
            ))}
          </div>
        )}
        <div className="flex items-center gap-2">
          <input
            ref={fileInputRef}
            type="file"
            multiple
            accept={FILE_INPUT_ACCEPT}
            className="hidden"
            onChange={handleFileInput}
          />
          <button
            onClick={() => fileInputRef.current?.click()}
            disabled={streamState.isStreaming || modelLoading || attachments.length >= MAX_ATTACHMENTS}
            className="p-2 rounded-xl transition-colors shrink-0 cursor-pointer disabled:opacity-30 disabled:cursor-default"
            style={{ background: 'transparent', color: 'var(--color-text-secondary)' }}
            title="Add files or photos"
          >
            <Paperclip size={16} />
          </button>
          <textarea
            ref={textareaRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            onPaste={handlePaste}
            placeholder="Message Vega..."
            rows={1}
            className="flex-1 bg-transparent outline-none resize-none text-sm leading-relaxed"
            style={{ color: 'var(--color-text)', maxHeight: '200px' }}
            disabled={streamState.isStreaming || modelLoading}
          />
          {streamState.isStreaming ? (
            <button
              onClick={stopStreaming}
              className="p-2 rounded-xl transition-colors shrink-0 cursor-pointer"
              style={{ background: 'var(--color-error)', color: 'var(--color-on-accent)' }}
              title="Stop generating"
            >
              <Square size={16} />
            </button>
          ) : (
            <div className="flex items-center gap-1">
              <MicButton
                state={speechState}
                onClick={handleMicClick}
                disabled={micDisabled}
                reason={micReason}
              />
              <button
                onClick={sendMessage}
                disabled={!canSend || modelLoading}
                className="p-2 rounded-xl transition-colors shrink-0 cursor-pointer disabled:opacity-30 disabled:cursor-default"
                style={{
                  background: canSend ? 'var(--color-accent)' : 'var(--color-bg-tertiary)',
                  color: canSend ? 'white' : 'var(--color-text-tertiary)',
                }}
                title="Send message"
              >
                <Send size={16} />
              </button>
            </div>
          )}
        </div>
      </div>
      {attachmentNote && (
        <div className="mt-1 text-[11px] text-center" style={{ color: 'var(--color-text-tertiary)' }}>
          {attachmentNote}
        </div>
      )}
      {hasImageAttachment && isImageBlindCloudModel && (
        <div className="mt-1 text-[11px] text-center" style={{ color: 'var(--color-text-tertiary)' }}>
          Images are read by local (Ollama) vision models and Gemini — the selected cloud model will only receive the text.
        </div>
      )}
      <div className="flex items-center justify-center mt-2 text-[11px]" style={{ color: 'var(--color-text-tertiary)' }}>
        <span>
          <kbd className="font-mono">Enter</kbd> to send &middot;{' '}
          <kbd className="font-mono">Shift+Enter</kbd> for new line
        </span>
      </div>
    </div>
  );
}
