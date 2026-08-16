# Providers

Vendor-independent interfaces for the three AI services Pipeflow drives, plus
their adapters.

```text
providers/
├── llm/       language models          (interface + adapters/deepseek)
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
generator. Adapters: `DeepSeekLLM` (OpenAI-compatible).

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

## TTS

```ts
interface TTS {
  stream(request: TTSRequest): AsyncGenerator<Uint8Array>;
  stop(): void;
}
```

`stream()` produces audio chunks as they become available and throws on
transport-level failures. Adapters: `KokoroTTS`.

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
