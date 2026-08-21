import type { STT, STTOptions, STTSession } from "../../types";
import type { FetchLike } from "../../../shared";

export interface OpenRouterSTTOptions extends STTOptions {
  apiKey: string;
  /** Defaults to `https://openrouter.ai/api/v1`. */
  baseUrl?: string;
  /** The STT model. Defaults to `openai/whisper-large-v3-turbo`. */
  model?: string;
  /**
   * Silence (ms) that ends an utterance. OpenRouter's transcription endpoint
   * is batch-only (one request per audio clip), so the adapter segments the
   * incoming stream client-side and transcribes a clip once this much silence
   * has elapsed since the last audio. Default 800.
   */
  silenceMs?: number;
  /** Injectable fetch, mainly for tests. */
  fetch?: FetchLike;
}

type OpenRouterEvent = "partial" | "final" | "error" | "close";

/**
 * OpenRouter batch STT adapter (`POST /api/v1/audio/transcriptions`).
 *
 * OpenRouter does not stream transcripts — it transcribes a complete audio
 * clip and returns the text. The adapter therefore buffers the raw audio
 * written by `write()`, assumes linear16 PCM (mono, `sampleRate`, default
 * 16 kHz — matching the Deepgram adapter's defaults), wraps each utterance
 * in a WAV header, and posts it after `silenceMs` of silence. Interim
 * results are unavailable, so no `partial` events are ever emitted: a turn
 * arrives whole at the `final` event once its clip has been transcribed.
 *
 * `language` accepts an ISO-639-1 code to force a language (which whisper
 * docs say improves accuracy and latency); omitting it — or passing `"auto"`,
 * the whisper convention, which is normalized to "omit" — leaves detection to
 * the provider, matching OpenRouter's "auto-detected if omitted" contract.
 *
 * `end()` transcribes any remaining buffered audio; `cancel()` drops
 * buffered audio and aborts in-flight requests.
 */
export class OpenRouterSTT implements STT {
  private readonly options: OpenRouterSTTOptions;
  private readonly sessions = new Set<OpenRouterSession>();

  constructor(options: OpenRouterSTTOptions) {
    if (!options.apiKey) {
      throw new Error("OpenRouterSTT requires an apiKey");
    }
    this.options = options;
  }

  start(options: STTOptions = {}): STTSession {
    const merged: OpenRouterSTTOptions = { ...this.options, ...options };
    const session = new OpenRouterSession(merged);
    this.sessions.add(session);
    session.on("close", () => {
      this.sessions.delete(session);
    });
    return session;
  }

  cancel(): void {
    for (const session of [...this.sessions]) {
      session.abort();
    }
  }
}

export class OpenRouterSession implements STTSession {
  private readonly listeners = new Map<OpenRouterEvent, Set<(...args: any[]) => void>>();
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly model: string;
  private readonly language: string | undefined;
  private readonly sampleRate: number;
  private readonly silenceMs: number;
  private readonly fetchImpl: FetchLike;

  private chunks: Uint8Array[] = [];
  private timer: ReturnType<typeof setTimeout> | null = null;
  private chain: Promise<void> = Promise.resolve();
  private readonly controllers = new Set<AbortController>();
  private ended = false;
  private aborted = false;

  constructor(options: OpenRouterSTTOptions) {
    this.apiKey = options.apiKey;
    this.baseUrl = (options.baseUrl ?? "https://openrouter.ai/api/v1").replace(/\/+$/, "");
    this.model = options.model ?? "openai/whisper-large-v3-turbo";
    // `"auto"` is the whisper convention for "let the provider detect";
    // OpenRouter detects when the field is omitted, so normalize it away
    // rather than forwarding a string some providers may reject.
    this.language = options.language === "auto" ? undefined : options.language;
    this.sampleRate = options.sampleRate ?? 16_000;
    this.silenceMs = options.silenceMs ?? 800;
    this.fetchImpl = options.fetch ?? fetch;
  }

  write(audio: Uint8Array): void {
    if (this.ended || this.aborted) {
      throw new Error("OpenRouter session is closed");
    }
    this.chunks.push(audio);
    // Restart the silence clock: a clip is finalized once no audio has
    // arrived for `silenceMs`.
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => this.flush(), this.silenceMs);
  }

  async end(): Promise<void> {
    if (this.ended) return;
    this.ended = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    // Transcribe any trailing audio, then wait for every queued clip.
    this.flush();
    await this.chain;
    this.emit("close");
  }

  /** Drop buffered audio and abort in-flight requests (cancel). */
  abort(): void {
    if (this.aborted) return;
    this.aborted = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.chunks = [];
    for (const controller of this.controllers) controller.abort();
    this.emit("close");
  }

  on(event: "partial", listener: (transcript: string) => void): void;
  on(event: "final", listener: (transcript: string) => void): void;
  on(event: "error", listener: (error: Error) => void): void;
  on(event: "close", listener: () => void): void;
  on(event: OpenRouterEvent, listener: (...args: any[]) => void): void {
    let set = this.listeners.get(event);
    if (!set) {
      set = new Set();
      this.listeners.set(event, set);
    }
    set.add(listener);
  }

  /** Queue a transcription of whatever audio is buffered (serialized). */
  private flush(): void {
    this.chain = this.chain.then(async () => {
      if (this.aborted) return;
      if (this.chunks.length === 0) return;
      const audio = this.takeBuffer();
      await this.transcribe(audio);
    });
  }

  private takeBuffer(): Uint8Array {
    const chunks = this.chunks;
    this.chunks = [];
    let total = 0;
    for (const chunk of chunks) total += chunk.byteLength;
    const out = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      out.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return out;
  }

  private async transcribe(audio: Uint8Array): Promise<void> {
    const controller = new AbortController();
    this.controllers.add(controller);
    try {
      const text = await transcribeClip({
        apiKey: this.apiKey,
        baseUrl: this.baseUrl,
        model: this.model,
        language: this.language,
        sampleRate: this.sampleRate,
        audio,
        signal: controller.signal,
        fetchImpl: this.fetchImpl,
      });
      if (!this.aborted && text) this.emit("final", text);
    } catch (error) {
      if (!this.aborted) {
        this.emit("error", error instanceof Error ? error : new Error(String(error)));
      }
    } finally {
      this.controllers.delete(controller);
    }
  }

  private emit(event: "partial", arg: string): void;
  private emit(event: "final", arg: string): void;
  private emit(event: "error", arg: Error): void;
  private emit(event: "close"): void;
  private emit(event: OpenRouterEvent, ...args: any[]): void {
    const set = this.listeners.get(event);
    if (!set) return;
    for (const listener of [...set]) {
      listener(...args);
    }
  }
}

interface TranscribeClipOptions {
  apiKey: string;
  baseUrl: string;
  model: string;
  language: string | undefined;
  sampleRate: number;
  audio: Uint8Array;
  signal: AbortSignal;
  fetchImpl: FetchLike;
}

async function transcribeClip(options: TranscribeClipOptions): Promise<string> {
  const form = new FormData();
  form.append("model", options.model);
  // OpenRouter accepts OpenAI-style multipart uploads; whisper reads the
  // raw linear16 PCM as a WAV clip.
  form.append("file", new Blob([toWav(options.audio, options.sampleRate)], { type: "audio/wav" }), "audio.wav");
  if (options.language) form.append("language", options.language);

  const response = await options.fetchImpl(`${options.baseUrl}/audio/transcriptions`, {
    method: "POST",
    headers: { authorization: `Bearer ${options.apiKey}` },
    body: form,
    signal: options.signal,
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(
      `OpenRouter transcription failed (${response.status})${detail ? `: ${detail}` : ""}`,
    );
  }
  const data = (await response.json()) as { text?: string };
  return (data.text ?? "").trim();
}

/**
 * Wrap linear16 PCM (mono) in a minimal WAV container so whisper can read it.
 * The header is the standard 44-byte RIFF/WAVE layout.
 */
export function toWav(pcm: Uint8Array, sampleRate: number): Uint8Array {
  const bytesPerSample = 2; // linear16
  const channels = 1;
  const byteRate = sampleRate * channels * bytesPerSample;
  const blockAlign = channels * bytesPerSample;
  const dataSize = pcm.byteLength;

  const wav = new Uint8Array(44 + dataSize);
  const view = new DataView(wav.buffer);
  wav.set([0x52, 0x49, 0x46, 0x46], 0); // "RIFF"
  view.setUint32(4, 36 + dataSize, true);
  wav.set([0x57, 0x41, 0x56, 0x45], 8); // "WAVE"
  wav.set([0x66, 0x6d, 0x74, 0x20], 12); // "fmt "
  view.setUint32(16, 16, true); // fmt chunk size
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, channels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, byteRate, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, bytesPerSample * 8, true);
  wav.set([0x64, 0x61, 0x74, 0x61], 36); // "data"
  view.setUint32(40, dataSize, true);
  wav.set(pcm, 44);
  return wav;
}
