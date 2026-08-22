import type { STT, STTOptions, STTSession } from "../../types";
import type { FetchLike } from "../../../shared";

/** Audio formats the OpenRouter transcription endpoint accepts. */
export type OpenRouterAudioFormat =
  | "pcm"
  | "mp3"
  | "flac"
  | "m4a"
  | "ogg"
  | "webm"
  | "aac";

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
  /**
   * Format of the audio written to the session. `"pcm"` (the default)
   * assumes raw linear16 samples at `sampleRate` and wraps each clip in a
   * WAV container. Pass the actual encoding (e.g. `"mp3"`, `"ogg"`, …) when
   * feeding pre-encoded audio — those formats are self-describing and are
   * sent as-is.
   */
  audioFormat?: OpenRouterAudioFormat;
  /**
   * Strip common whisper hallucinations from transcripts: asterisk stage
   * directions ("*Dramatic music*"), repeated filler phrases ("Thank you.
   * Thank you."), and pure-filler clips whisper emits on near-silence
   * ("Thank you.", "E aí.", "Bye.", …). Set `false` to pass transcripts
   * through untouched. Default `true`.
   */
  filterHallucinations?: boolean;
  /**
   * Extra phrases (lowercased) treated as hallucinations on top of the
   * built-in multilingual filler list — for fillers whisper "hears" in the
   * languages you deploy. A transcript that is *entirely* built from known
   * fillers is dropped. Default none.
   */
  fillerPhrases?: string[];
  /**
   * Energy floor (0–1 RMS, on the raw sample range) for transcribing a
   * buffered `pcm` clip. Near-silence clips — the ones whisper hallucinates
   * "E aí." / "Thank you." / *stage directions* on — are skipped entirely
   * (no transcription request, no `final`), instead of being filtered after
   * the fact. Real speech sits far above any reasonable floor; start around
   * `0.01`–`0.02` and raise it if artifacts persist. Only applies to
   * `audioFormat: "pcm"` (the only format whose samples are measurable).
   * Default: no floor (transcribe everything the client sends).
   */
  minClipRms?: number;
  /**
   * Called for every buffered `pcm` clip with its measured mean RMS and
   * whether it was transcribed — for logging the real distribution and
   * tuning `minClipRms` against it (speech clips sit far above artifact
   * clips). Fires when this callback or `minClipRms` is set.
   */
  onClipEnergy?: (rms: number, transcribed: boolean) => void;
  /**
   * Sampling temperature (0–1) for transcription. Lower is more
   * deterministic; whisper's API default is already 0, so this is rarely the
   * lever for hallucinations.
   */
  temperature?: number;
  /**
   * Provider-specific passthrough, serialized as the `provider` multipart
   * field. OpenRouter ignores the top-level `prompt` field ("accepted but
   * ignored"), so the only way to reach whisper's prompt — vocabulary /
   * context steering — is per-provider:
   *
   * ```ts
   * providerOptions: { options: { groq: { prompt: "Transcribe exactly what is said." } } }
   * ```
   *
   * Only the options for the provider that actually serves the request are
   * forwarded, so the key must match the serving provider (openai, groq,
   * together, …).
   */
  providerOptions?: Record<string, unknown>;
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
 * By default the written audio is treated as raw linear16 PCM and wrapped in
 * a WAV container; set `audioFormat` to the real encoding (e.g. `"mp3"`) to
 * send pre-encoded audio as-is instead.
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
    // Pass the adapter's own options object as the live source: the session
    // snapshots the per-session overrides but reads live-tunable options
    // (minClipRms) through the adapter, so runtime changes apply to every
    // session without recreating it.
    const session = new OpenRouterSession(merged, this.options);
    this.sessions.add(session);
    session.on("close", () => {
      this.sessions.delete(session);
    });
    return session;
  }

  /**
   * Live-tunable energy floor (0–1 RMS) for `pcm` clips: raise it to skip
   * more near-silence clips (the whisper hallucinations), lower it to keep
   * quieter speech. Applies to all sessions immediately.
   */
  set minClipRms(value: number | undefined) {
    this.options.minClipRms = value;
  }

  get minClipRms(): number | undefined {
    return this.options.minClipRms;
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
  private readonly audioFormat: OpenRouterAudioFormat;
  private readonly filterHallucinations: boolean;
  private readonly fillerPhrases: string[] | undefined;
  private readonly onClipEnergy: ((rms: number, transcribed: boolean) => void) | undefined;
  private readonly temperature: number | undefined;
  private readonly providerOptions: Record<string, unknown> | undefined;
  private readonly fetchImpl: FetchLike;
  /** The adapter's live options object; live-tunable fields are read here. */
  private readonly liveOptions: OpenRouterSTTOptions;

  /** Live-tunable energy floor, read through the adapter (not a snapshot). */
  private get minClipRms(): number | undefined {
    return this.liveOptions.minClipRms;
  }

  private chunks: Uint8Array[] = [];
  private timer: ReturnType<typeof setTimeout> | null = null;
  private chain: Promise<void> = Promise.resolve();
  private readonly controllers = new Set<AbortController>();
  private ended = false;
  private aborted = false;

  constructor(options: OpenRouterSTTOptions, liveOptions: OpenRouterSTTOptions) {
    this.apiKey = options.apiKey;
    this.baseUrl = (options.baseUrl ?? "https://openrouter.ai/api/v1").replace(/\/+$/, "");
    this.model = options.model ?? "openai/whisper-large-v3-turbo";
    // `"auto"` is the whisper convention for "let the provider detect";
    // OpenRouter detects when the field is omitted, so normalize it away
    // rather than forwarding a string some providers may reject.
    this.language = options.language === "auto" ? undefined : options.language;
    this.sampleRate = options.sampleRate ?? 16_000;
    this.silenceMs = options.silenceMs ?? 800;
    this.audioFormat = options.audioFormat ?? "pcm";
    this.filterHallucinations = options.filterHallucinations ?? true;
    this.fillerPhrases = options.fillerPhrases;
    this.onClipEnergy = options.onClipEnergy;
    this.temperature = options.temperature;
    this.providerOptions = options.providerOptions;
    this.fetchImpl = options.fetch ?? fetch;
    this.liveOptions = liveOptions;
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
  /**
   * Queue a transcription of whatever audio is buffered (serialized). The
   * clip boundary is frozen *now* — the moment the trailing silence was
   * detected — so audio that arrives while this transcription is queued or
   * in flight starts the next clip instead of being swept into this one.
   */
  private flush(): void {
    if (this.aborted) return;
    const audio = this.takeBuffer();
    if (audio.byteLength === 0) return;
    this.chain = this.chain.then(async () => {
      if (this.aborted) return;
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
    // Near-silence clips (the ones whisper hallucinates on) are dropped at
    // the source: below the energy floor the clip is never sent, saving the
    // transcription round trip and preventing the fabricated turn entirely.
    if (this.audioFormat === "pcm" && (this.minClipRms !== undefined || this.onClipEnergy)) {
      const rms = pcmRms(audio);
      const transcribed = this.minClipRms === undefined || rms >= this.minClipRms;
      this.onClipEnergy?.(rms, transcribed);
      if (!transcribed) return;
    }
    const controller = new AbortController();
    this.controllers.add(controller);
    try {
      const raw = await transcribeClip({
        apiKey: this.apiKey,
        baseUrl: this.baseUrl,
        model: this.model,
        language: this.language,
        sampleRate: this.sampleRate,
        audioFormat: this.audioFormat,
        temperature: this.temperature,
        providerOptions: this.providerOptions,
        audio,
        signal: controller.signal,
        fetchImpl: this.fetchImpl,
      });
      const text = this.filterHallucinations
        ? cleanTranscript(raw, this.fillerPhrases)
        : raw;
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
  audioFormat: OpenRouterAudioFormat;
  temperature: number | undefined;
  providerOptions: Record<string, unknown> | undefined;
  audio: Uint8Array;
  signal: AbortSignal;
  fetchImpl: FetchLike;
}

const AUDIO_MIME: Record<Exclude<OpenRouterAudioFormat, "pcm">, string> = {
  mp3: "audio/mpeg",
  flac: "audio/flac",
  m4a: "audio/mp4",
  ogg: "audio/ogg",
  webm: "audio/webm",
  aac: "audio/aac",
};

async function transcribeClip(options: TranscribeClipOptions): Promise<string> {
  const form = new FormData();
  form.append("model", options.model);
  // OpenRouter accepts OpenAI-style multipart uploads. Raw linear16 PCM is
  // wrapped in a WAV container so whisper can read it; pre-encoded formats
  // (mp3, ogg, …) are self-describing and sent as-is.
  let bytes: Uint8Array;
  let name: string;
  let type: string;
  if (options.audioFormat === "pcm") {
    bytes = toWav(options.audio, options.sampleRate);
    name = "audio.wav";
    type = "audio/wav";
  } else {
    bytes = options.audio;
    name = `audio.${options.audioFormat}`;
    type = AUDIO_MIME[options.audioFormat];
  }
  form.append("file", new Blob([bytes], { type }), name);
  if (options.language) form.append("language", options.language);
  if (options.temperature !== undefined) {
    form.append("temperature", String(options.temperature));
  }
  // The only way to reach whisper's `prompt` through OpenRouter (the
  // top-level field is accepted but ignored) is per-provider passthrough.
  if (options.providerOptions) {
    form.append("provider", JSON.stringify(options.providerOptions));
  }

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

/**
 * Mean RMS of linear16 PCM (mono), in the 0–1 sample range. Used as the
 * clip-level energy floor: near-silence clips sit far below real speech.
 */
export function pcmRms(pcm: Uint8Array): number {
  const sampleCount = Math.floor(pcm.byteLength / 2);
  if (sampleCount === 0) return 0;
  let sum = 0;
  for (let i = 0; i < sampleCount; i++) {
    const lo = pcm[i * 2]!;
    const hi = pcm[i * 2 + 1]!;
    const sample = lo | (hi << 8);
    const signed = sample >= 0x8000 ? sample - 0x10000 : sample;
    sum += signed * signed;
  }
  return Math.sqrt(sum / sampleCount) / 32768;
}

/**
 * Conversational fillers whisper loves to "hear" when a clip is mostly
 * silence (a trailing gap, a cough, the speaker's own voice echoing back).
 * Only a transcript that is *entirely* built from these is dropped, so a
 * genuine "thank you" still passes through when it is part of a longer
 * utterance. The list is multilingual because whisper fills near-silence
 * with the language it thinks it heard ("E aí" for Portuguese speech, …).
 */
const FILLER_PHRASES = [
  // English
  "thank you",
  "thanks",
  "thank you for watching",
  "thanks for watching",
  "please subscribe",
  "bye bye",
  "goodbye",
  "bye",
  "good night",
  "i love you",
  "love you",
  "you're welcome",
  "no problem",
  "have a great day",
  "see you later",
  "see you",
  "okay",
  "ok",
  // Portuguese
  "e aí",
  "e ai",
  "oi",
  "olá",
  "ola",
  "tudo bem",
  "obrigado",
  "obrigada",
  "tá bom",
  "ta bom",
  "tchau",
  "adeus",
  "bom dia",
  "boa noite",
  "entendi",
  "ah bom",
  "é isso",
  // Spanish
  "hola",
  "qué tal",
  "que tal",
  "vale",
  "adiós",
  "adios",
  // French
  "bonjour",
  "merci",
  "d'accord",
  "au revoir",
  // German
  "hallo",
  "danke",
  "tschüss",
  "tschuss",
];

/**
 * True when `text` is entirely a concatenation of known filler phrases
 * ("E aí.", "E aí E aí", "ok ok thank you"), with punctuation and extra
 * whitespace ignored. Repeated fillers are the classic near-silence
 * artifact — whisper often emits them with no sentence boundary at all.
 */
function isFillerOnly(text: string, phrases: string[]): boolean {
  const normalized = text
    .toLowerCase()
    .replace(/[.,!?;:]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (normalized.length === 0) return false;
  const sorted = [...phrases].sort((a, b) => b.length - a.length);
  let rest = normalized;
  let matched = false;
  for (;;) {
    const found = sorted.find((phrase) => rest.startsWith(phrase));
    if (!found) break;
    matched = true;
    rest = rest.slice(found.length).replace(/^\s+/, "");
    if (rest.length === 0) break;
  }
  return matched && rest.length === 0;
}

/**
 * Clean a whisper transcript of its most common hallucinations, returning
 * "" when nothing worth speaking remains:
 *
 * 1. Asterisk stage directions ("*Dramatic music*", "*laughs*") are
 *    dropped — whisper transcribes background noise as stage notes.
 * 2. Consecutive repeated sentences ("Thank you. Thank you.") collapse to
 *    one — a doubled filler is a classic near-silence artifact.
 * 3. A transcript built entirely from filler phrases (the built-in
 *    multilingual list plus `extraFillers`) is dropped.
 */
export function cleanTranscript(text: string, extraFillers: string[] = []): string {
  let out = text
    .replace(/\*[^*]*\*/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (out.length === 0) return "";

  const sentences = out.split(/(?<=[.!?])\s+/).filter((sentence) => sentence.length > 0);
  const collapsed: string[] = [];
  for (const sentence of sentences) {
    const last = collapsed.at(-1);
    if (last !== undefined && last.toLowerCase() === sentence.toLowerCase()) continue;
    collapsed.push(sentence);
  }
  out = collapsed.join(" ").trim();
  if (out.length === 0) return "";

  const phrases = [...FILLER_PHRASES, ...extraFillers.map((phrase) => phrase.toLowerCase())];
  const normalized = out.toLowerCase().replace(/[.!?]+$/g, "");
  return FILLER_PHRASES.includes(normalized) || isFillerOnly(out, phrases) ? "" : out;
}
