# Providers

Vendor-independent interfaces for the three AI services Pipeflow drives, plus
their adapters.

```text
providers/
├── llm/       language models          (interface + adapters/deepseek, openrouter)
├── stt/       speech-to-text           (interface + adapters/deepgram)
└── tts/       text-to-speech           (interface + adapters/kokoro)
```

The orchestrator works against the **interfaces**, never vendor APIs — swap a
provider without touching the conversation layer.

## LLM

```ts
interface LLM {
  stream(request: LLMRequest): AsyncGenerator<LLMEvent>;
  stop(): void;
}
```

`stream()` yields `delta` (text tokens), `tool_call` (with JSON-encoded
arguments), `done`, or `error` events. Transport failures are thrown from the
generator. Adapters: `DeepSeekLLM`, `OpenRouterLLM` (both OpenAI-compatible).

Both adapters accept an optional `onTiming` callback that fires at
`request-start`, `headers`, and `first-chunk` — enough to split application
delay, network/queue delay, and model TTFT apart when profiling voice latency:

## STT

```ts
interface STT {
  start(options?: STTOptions): STTSession;
  cancel(): void;
}
```

`start()` opens a streaming session; audio is fed in with `write()` and
transcripts are reported via `partial`/`final` events. Adapters:
`DeepgramSTT`.

### Conversational STT (Deepgram Flux)

Flux is Deepgram's conversational model with model-integrated end-of-turn
detection, built for voice agents. It is the `DeepgramSTT` default: `flux-*`
models route to the `/v2/listen` endpoint automatically:

```ts
const stt = new DeepgramSTT({
  apiKey: process.env.DEEPGRAM_API_KEY,
  model: "flux-general-en", // or flux-general-multi (10 languages)
});
```

Notes:

- Flux requires the `/v2/listen` endpoint and `encoding`/`sample_rate`
  (`linear16` / `16000` by default) — the adapter handles both.
- Feed audio in ~80ms chunks for optimal model performance and latency
  (≈2560 bytes at 16 kHz linear16).
- End-of-turn behavior is tunable via `eot_threshold` / `eager_eot_threshold`
  / `eot_timeout_ms`; the adapter currently surfaces transcripts as
  `partial`/`final` — Flux's `EagerEndOfTurn` early-response events are a
  designed-for integration point.
- Don't pass `language` with `flux-general-en`; `flux-general-multi` uses
  `language_hint` for language biasing (not yet exposed by the adapter).

## TTS

```ts
interface TTS {
  stream(request: TTSRequest): AsyncGenerator<Uint8Array>;
  stop(): void;
}
```

### Hosted TTS (Together AI)

`KokoroTTS` targets any OpenAI-compatible `/v1/audio/speech` endpoint — a
local [kokoro-fastapi](https://github.com/remsky/Kokoro-FastAPI) server by
default, or a hosted service such as [Together AI](https://www.together.ai),
which serves the model as `hexgrad/Kokoro-82M`:

```ts
const tts = new KokoroTTS({
  baseUrl: "https://api.together.ai",
  apiKey: process.env.TOGETHER_API_KEY,
  model: "hexgrad/Kokoro-82M",
  stream: true, // progressive audio; only raw output is streamable
});
```

Notes:

- Together AI defaults to non-streaming — pass `stream: true` for realtime
  playback. Streaming responses are server-sent events carrying base64-encoded
  audio deltas (`conversation.item.audio_output.delta`, terminating in
  `data: [DONE]`); the adapter decodes them into raw audio chunks (pcm_s16le,
  24 kHz for Kokoro). wav/mp3 requests are passed through for non-streaming
  synthesis.
- List available voices via Together AI's `/v1/voices` endpoint; the default
  voice (`af_heart`) is supported.
- For the lowest latency, Together AI also exposes a realtime WebSocket
  endpoint (`/v1/audio/speech/websocket`) — a designed-for adapter, not yet
  shipped.

## Usage

```ts
import { DeepSeekLLM, DeepgramSTT, KokoroTTS } from "@moureau/pipeflow/providers";

const pipeflow = new Pipeflow({
  llm: new DeepSeekLLM({ apiKey: process.env.DEEPSEEK_API_KEY }),
  stt: new DeepgramSTT({ apiKey: process.env.DEEPGRAM_API_KEY }),
  tts: new KokoroTTS({ baseUrl: "http://localhost:8880" }),
});
```

Types are importable from the same subpath
(`@moureau/pipeflow/providers/llm`, `/stt`, `/tts` for the individual
interfaces). See the root [README](../../README.md) for the public API.
