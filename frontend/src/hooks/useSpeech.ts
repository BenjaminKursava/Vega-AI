import { useState, useCallback, useRef, useEffect } from 'react';
import { transcribeAudio, fetchSpeechHealth } from '../lib/api';

export type SpeechState = 'idle' | 'recording' | 'transcribing';

export function useSpeech() {
  const [state, setState] = useState<SpeechState>('idle');
  const [error, setError] = useState<string | null>(null);
  const [available, setAvailable] = useState(false);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const streamRef = useRef<MediaStream | null>(null);
  // Live-preview transcription while still recording: callback that receives
  // interim text, and a busy flag so only one preview request runs at a time.
  const onInterimRef = useRef<((text: string) => void) | null>(null);
  const interimBusyRef = useRef(false);

  // Check if speech backend is available on mount
  useEffect(() => {
    fetchSpeechHealth()
      .then((health) => setAvailable(health.available))
      .catch(() => setAvailable(false));
  }, []);

  const startRecording = useCallback(async (onInterim?: (text: string) => void): Promise<void> => {
    setError(null);
    onInterimRef.current = onInterim ?? null;
    interimBusyRef.current = false;

    if (!navigator.mediaDevices?.getUserMedia) {
      setError('Microphone not supported in this browser');
      return;
    }

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;

      const recorder = new MediaRecorder(stream);
      chunksRef.current = [];

      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) chunksRef.current.push(e.data);

        // Live preview: while still recording, transcribe everything captured
        // SO FAR. The cumulative blob keeps the WebM header from the first
        // chunk and gives Whisper full context, so the preview text refines
        // itself as the recording grows. Only one preview request runs at a
        // time (each tick re-sends the whole audio, so a slow CPU simply gets
        // fewer, larger updates instead of a queue). Preview errors are
        // ignored — the final pass in stopRecording is authoritative.
        if (
          onInterimRef.current &&
          !interimBusyRef.current &&
          recorder.state === 'recording' &&
          chunksRef.current.length > 0
        ) {
          interimBusyRef.current = true;
          const preview = new Blob(chunksRef.current.slice(), {
            type: recorder.mimeType || 'audio/webm',
          });
          transcribeAudio(preview)
            .then((res) => {
              if (recorder.state === 'recording' && onInterimRef.current && res.text) {
                onInterimRef.current(res.text);
              }
            })
            .catch(() => {})
            .finally(() => {
              interimBusyRef.current = false;
            });
        }
      };

      // Timeslice makes ondataavailable fire periodically → live preview ticks.
      recorder.start(1500);
      mediaRecorderRef.current = recorder;
      setState('recording');
    } catch (err) {
      setError('Microphone access denied');
      setState('idle');
    }
  }, []);

  const stopRecording = useCallback(async (): Promise<string> => {
    return new Promise((resolve, reject) => {
      const recorder = mediaRecorderRef.current;
      if (!recorder || recorder.state !== 'recording') {
        reject(new Error('Not recording'));
        return;
      }

      recorder.onstop = async () => {
        // No more interim updates — the final transcription below owns the
        // text from here on (a late preview response is also gated by the
        // recorder.state check at its call site).
        onInterimRef.current = null;
        setState('transcribing');

        // Stop all audio tracks
        streamRef.current?.getTracks().forEach((track) => track.stop());
        streamRef.current = null;

        const blob = new Blob(chunksRef.current, { type: recorder.mimeType || 'audio/webm' });
        chunksRef.current = [];

        try {
          const result = await transcribeAudio(blob);
          setState('idle');
          resolve(result.text);
        } catch (err) {
          setState('idle');
          const msg = err instanceof Error ? err.message : 'Transcription failed';
          setError(msg);
          reject(err);
        }
      };

      recorder.stop();
    });
  }, []);

  return {
    state,
    error,
    available,
    startRecording,
    stopRecording,
    isRecording: state === 'recording',
    isTranscribing: state === 'transcribing',
  };
}
