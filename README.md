# Pipeflow

Realtime voice infrastructure for TypeScript.

Pipeflow is an open-source backend SDK for building voice agents, conversational applications, meeting transcribers, Discord bots, recruiters, assistants, and other realtime audio experiences.

It handles the plumbing between audio, speech-to-text, LLMs, text-to-speech, conversations, tools, and persistence—while keeping your application in control.

> **Pipeflow is the pipe. You build what flows through it.**

## Highlights

* **Small** — under 100 kB packed, zero runtime dependencies.
* **Realtime by default** — audio, transcripts, and speech stream continuously, with built-in interruption and barge-in handling.
* **Provider-agnostic** — STT, LLM, and TTS are swappable adapters (Deepgram, DeepSeek, and Kokoro today).
* **Your backend stays yours** — tools and the audio transport are owned by your application; Pipeflow never executes your code.

## Status

🚧 **Early development**

The API is evolving and should be considered experimental.

## Philosophy

Pipeflow has four core concepts:

* **Agent** — intelligence, context, and tools.
* **Conversation** — a persistent realtime conversation and its participants.
* **Tool** — application capabilities executed by your backend.
* **Provider** — an implementation of STT, LLM, or TTS.

The goal is to keep these concerns independent.

An agent does not inherently own a conversation. A conversation does not require an agent. A provider should not leak into your application logic.

```text
                         Pipeflow

    ┌──────────────┐
    │    Agent     │
    │ context      │
    │ tools        │
    └──────┬───────┘
           │
           ▼
    ┌──────────────┐
    │ Conversation │
    │              │
    │ participants │
    │ turns        │
    │ audio        │
    │ interruption  │
    └──────┬───────┘
           │
           ▼
    ┌─────────────────────────┐
    │      Orchestrator       │
    └──────┬──────┬──────┬────┘
           │      │      │
          STT    LLM    TTS
           │      │      │
           ▼      ▼      ▼
       Deepgram DeepSeek Kokoro
```

## Installation

```bash
bun add @moureau/pipeflow
```

The package is not published to npm yet. Until then, install from the
repository (`bun add git@github.com:moureau-dev/pipeflow.git`) or build from
source — see [Development](#development).

## Basic voice agent

Create an agent:

```ts
import { Pipeflow } from "@moureau/pipeflow";
import { DeepSeekLLM, DeepgramSTT, KokoroTTS } from "@moureau/pipeflow/providers";

// Providers are configured explicitly with their own credentials —
// Pipeflow itself does not hold an API key.
const stt = new DeepgramSTT({ apiKey: process.env.DEEPGRAM_API_KEY });
const tts = new KokoroTTS();

const pipeflow = new Pipeflow({
  llm: new DeepSeekLLM({ apiKey: process.env.DEEPSEEK_API_KEY }),
  stt,
  tts,
});

const jarvis = pipeflow.agent({
  name: "Jarvis",

  context: `
    You are Jarvis, a helpful voice assistant.
    Keep your responses concise and conversational.
  `,
});
```

Create a conversation:

```ts
const conversation = await pipeflow.conversations.create({
  agents: [jarvis],
});
```

Starting a conversation starts its realtime machinery: `start()` attaches the
orchestrator, which runs the STT → turns → LLM → TTS pipeline for the
conversation.

```ts
await conversation.start();
```

Add a participant:

Feed it audio as it arrives:

```ts
voice.onAudio((audio) => {
  conversation.listen({
    userId: "alice",
    audio,
  });
});
```

Listen for generated audio:

```ts
conversation.on("audio", ({ audio }) => {
  voice.play(audio);
});
```

When finished:

```ts
await conversation.stop();
```

The application owns the audio transport. Pipeflow handles the realtime voice pipeline.

```text
Your application
      │
      │ audio chunks
      ▼
   Pipeflow
      │
      ├── STT
      ├── conversation orchestration
      ├── LLM
      └── TTS
      │
      │ audio chunks
      ▼
Your application
```

## Conversations

A conversation is the persistent entity representing a realtime interaction.

```ts
const conversation =
  await pipeflow.conversations.create({
    agents: [jarvis],
  });

console.log(conversation.id);

conversation.start();
```

Creation and realtime execution are deliberately separate.

```ts
create()       // creates the persistent conversation
start()        // moves the conversation into the started state
participate()  // adds participants
listen()       // sends audio
stop()         // finalizes the realtime session
```

Realtime processing is attached automatically by `start()`: the orchestrator
subscribes to `audio-in` events, runs the STT/LLM/TTS pipeline, and pushes
generated audio, turns, transcripts, and tool calls back through conversation
events.

`listen()` is intentionally synchronous:

```ts
conversation.listen({
  userId,
  audio,
});
```

It means:

> Send this audio packet.

It does not mean:

> Wait for this utterance to finish.

This makes it suitable for high-frequency realtime audio streams.

## Participants

Participants can be added individually:

```ts
await conversation.participate({
  userId: "alice",
});
```

Or in batches:

```ts
await conversation.participate([
  { userId: "alice" },

  {
    userId: "bob",
    aliases: ["robert", "rob"],
  },

  {
    userId: "charlie",
    aliases: ["charles"],
  },
]);
```

Participant information can be used for speaker attribution, conversation history, addressing, and multi-participant floor management.

## Interruption

Voice conversations need to feel immediate.

If an agent is speaking and a participant starts talking, Pipeflow can interrupt
the current output immediately rather than waiting for the entire utterance to
be transcribed.

Interruptions can be triggered by the application — or automatically: the
orchestrator detects when a participant starts speaking while the agent is
responding (barge-in).

```ts
conversation.interrupt(); // stops TTS, cancels the current generation
```

The interrupting speech keeps flowing into STT and becomes the next turn.

Conceptually:

```text
Agent is speaking
       │
       ▼
Participant starts speaking
       │
       ├── stop TTS
       ├── cancel current generation
       └── continue receiving speech
                  │
                  ▼
                STT
                  │
                  ▼
            new conversation turn
```

This keeps interactions responsive even when the user interrupts the agent halfway through a sentence.

## Conversation events

The conversation emits a typed event stream the application can subscribe to:

* `audio-in` — raw audio fed in via `listen()`
* `partial-transcript` — live STT partials (captions)
* `turn` — a finalized participant turn
* `transcript` — a transcript entry
* `audio` — generated audio to play
* `generation` — an agent generation
* `tool-call` / `tool-call-result` — tool execution round trips
* `interrupt` — an interruption occurred
* `error` — a provider failure
* `start` / `stop` / `state` — lifecycle

```ts
conversation.on("audio", ({ audio }) => voice.play(audio));
conversation.on("partial-transcript", ({ text }) => captions.update(text));
```

## Multi-participant conversations

<details>
<summary>Batching participants, conversational state, and the roadmap for floor management and addressing</summary>

Conversations can contain multiple participants and agents.

```ts
const conversation =
  await pipeflow.conversations.create({
    agents: [jarvis],
  });

await conversation.participate([
  { userId: "alice" },
  { userId: "bob" },
  { userId: "charlie" },
]);
```

The conversation orchestrator maintains conversational state such as:

* active turns
* participant identity
* interruptions
* agent generations
* transcript state

In a one-to-one conversation, speech is treated as an interaction: every
finalized participant turn produces an agent generation.

Addressing works at a basic level: a turn is routed to the agent whose name
or alias appears in the speech, falling back to the first agent in the roster.
Floor management, multi-participant turn-taking rules, and richer addressing
heuristics are on the roadmap. A wake word is not intended to be a
fundamental requirement.

</details>

## Agents

An agent defines an AI persona and its capabilities.

```ts
const jarvis = pipeflow.agent({
  name: "Jarvis",

  context: `
    You are Jarvis.
    You are concise, helpful, and conversational.
  `,

  tools: [
    getWeather,
    searchCalendar,
  ],
});
```

Agents can also be run independently of conversations:

```ts
const result = await jarvis.run({
  prompt: "Explain how a neural network works.",
});

console.log(result.text);
```

This is useful for ordinary LLM workloads where realtime audio and conversation state are not required.

### Conversational agents

When an agent is attached to a conversation, it can take conversational turns as part of the realtime orchestration.

The conversation owns the runtime.

The agent owns the intelligence.

A conversation can coordinate **multiple agents**: `create({ agents })` accepts
a roster, and each turn is routed to the agent whose name or alias appears in
the speech — falling back to the first agent when none is addressed. Each
agent keeps its own context and its own LLM; the conversation owns the shared
runtime (STT, TTS, history, interruptions).

```ts
const receptionist = pipeflow.agent({
  name: "Receptionist",
  context: `
    You are the front desk. Greet people and route requests.
  `,
});

const specialist = pipeflow.agent({
  name: "Technical Specialist",
  aliases: ["tech"],
  context: `
    You are the technical support specialist.
  `,
});

const conversation =
  await pipeflow.conversations.create({
    agents: [receptionist, specialist],
  });
```

"Ask the technical specialist about X" is routed to the specialist; an
unaddressed turn goes to the first agent in the roster.

```text
Agent
 ├── context
 └── tools

Conversation
 ├── participants
 ├── turns
 ├── audio
 ├── interruption
 └── orchestration
```

## Tools

Tools expose capabilities from your application to an agent.

```ts
const getWeather = new PipeflowTool({
  name: "get_weather",

  description: "Get the current weather for a city.",

  execute: async ({ city }) => {
    return weatherService.getCurrent(city);
  },
});
```

Then:

```ts
const jarvis = pipeflow.agent({
  name: "Jarvis",

  context: "You are a helpful assistant.",

  tools: [getWeather],
});
```

Tools execute in **your backend**.

Pipeflow does not execute arbitrary application code.

```text
                    Pipeflow
                       │
                 LLM requests tool
                       │
                       ▼
              ┌─────────────────┐
              │ Your application │
              │                 │
              │ execute()       │
              └────────┬────────┘
                       │
                       ▼
                 tool result
                       │
                       ▼
                      LLM
```

This allows tools to access your database, APIs, Discord bot, business logic, filesystem, or anything else your application controls.

In a conversation, tool calls never execute inside Pipeflow. The orchestrator
emits a `tool-call` event with the requested tool and its arguments; your
backend executes it and reports back:

```ts
conversation.on("tool-call", async ({ call }) => {
  const result = await myBackend.execute(call.name, call.arguments);

  conversation.resolveToolCall({
    id: call.id,
    result,
  });
});
```

The agent's narration continues while the tool runs, and the generation resumes
with the tool result once it is resolved.

## Meeting transcription

A conversation does not require an agent.

This makes Pipeflow useful as a realtime transcription primitive.

```ts
const conversation =
  await pipeflow.conversations.create();

// Without an agent, `start()` attaches the orchestrator in
// transcription-only mode: audio in, turns and transcripts out.
await conversation.start();

await conversation.participate([
  { userId: "alice" },
  { userId: "bob", aliases: ["robert"] },
]);

discordVoice.onAudio((userId, audio) => {
  conversation.listen({
    userId,
    audio,
  });
});

await conversation.stop();
```

Retrieve the transcript afterward:

```ts
const transcript =
  await pipeflow.conversations.transcript(
    conversation.id,
  );
```

Transcript retrieval is separate from `stop()` so that ending a conversation does not require loading an arbitrarily large transcript into memory.

Pagination can be supported for long conversations.

## Meeting summaries

<details>
<summary>Summarizing a meeting with a notetaker agent — as a plain LLM task or through a transcript tool</summary>

A meeting summary can simply be another agent task.

```ts
const notetaker = pipeflow.agent({
  name: "Meeting Notetaker",

  context: `
    You are a meeting notetaker.

    Produce concise notes containing:
    - summary
    - decisions
    - action items
    - unresolved questions
  `,
});
```

Retrieve the transcript:

```ts
const transcript =
  await pipeflow.conversations.transcript(
    conversation.id,
  );
```

Then run the agent:

```ts
const result = await notetaker.run({
  prompt: `
    The meeting transcription is:

    ${transcript.join("\n")}

    Produce the meeting notes.
  `,
});
```

Or the notetaker can retrieve the transcript itself through a tool:

```ts
const getTranscript = new PipeflowTool({
  name: "get_transcript",

  description: "Retrieve the meeting transcript.",

  execute: async () => {
    return pipeflow.conversations.transcript(
      conversation.id,
    );
  },
});
```

The agent does not receive special access to conversations.

If it needs conversation data, **a tool provides that capability**.

</details>

## Providers

<details>
<summary>Vendor-independent interfaces and the current adapters: Deepgram, DeepSeek, Kokoro</summary>

Pipeflow separates provider interfaces from provider implementations.

```text
providers/
├── llm/
│   ├── types.ts
│   └── adapters/
│       └── deepseek/
│
├── stt/
│   ├── types.ts
│   └── adapters/
│       └── deepgram/
│
└── tts/
    ├── types.ts
    └── adapters/
        └── kokoro/
```

The orchestrator works against provider interfaces rather than directly against vendor APIs.

This makes it possible to replace providers without changing the conversation layer.

### Current providers

The project currently contains adapters for:

* **STT:** Deepgram
* **LLM:** DeepSeek
* **TTS:** Kokoro

Providers are configured with their own credentials — Pipeflow itself does
not hold an API key.

Provider availability and configuration are evolving during early development.

</details>

## Architecture

<details>
<summary>How the layers fit together: agents, conversations, persistence, providers, transport</summary>

Pipeflow is designed around a small number of independent layers.

```text
src/
├── agents/
├── conversations/
│   ├── conversation/
│   ├── orchestration/
│   └── transcription/
├── persistence/
│   └── adapters/
├── providers/
│   ├── llm/
│   ├── stt/
│   └── tts/
└── transport/
```

### Conversation

Public realtime conversation API and lifecycle.

### Orchestration

The state machine coordinating:

* speech
* transcription
* turns
* floor state
* agent generation
* interruptions
* tools
* TTS

### Transcription

Conversation transcription and transcript state.

### Providers

Vendor-independent interfaces and provider adapters.

### Persistence

Persistence abstractions with adapters such as SQLite and in-memory storage.

### Transport

Realtime communication between Pipeflow and the application using Pipeflow.

</details>

## Persistence

<details>
<summary>Storage adapters: in-memory for development, SQLite for lightweight persistence</summary>

Pipeflow separates persistence from the conversation domain.

The project currently includes:

```text
persistence/
└── adapters/
    ├── memory/
    └── sqlite/
```

The in-memory adapter is useful for tests and development.

SQLite provides a lightweight persistent backend suitable for local applications and early deployments.

The persistence interface is intentionally provider-independent so other storage implementations can be added later.

</details>

## Realtime architecture

<details>
<summary>How audio flows through the pipeline as a continuous stream</summary>

A typical voice interaction looks like:

```text
                Audio input
                     │
                     ▼
               Speech detection
                     │
                     ▼
                  STT stream
                     │
              partial transcript
                     │
                     ▼
             Conversation state
                     │
               turn completed
                     │
                     ▼
                  LLM stream
                     │
                token stream
                     │
                     ▼
                  TTS stream
                     │
                audio chunks
                     │
                     ▼
                Application
```

Everything happens as a stream.

Pipeflow does not wait for a complete recording before beginning transcription, nor does it wait for a complete LLM response before beginning TTS.

The intended flow is:

```text
audio
  ↓
partial STT
  ↓
turn detection
  ↓
LLM streaming
  ↓
TTS streaming
  ↓
audio
```

This allows the system to begin producing speech as early as possible.

</details>

## Open source

<details>
<summary>Why the project is open and how the provider layer stays modular</summary>

Pipeflow is open source.

The project is designed to make realtime voice infrastructure accessible without requiring applications to implement their own orchestration layer.

The provider layer is intentionally modular so applications can choose between hosted and self-hosted services.

</details>

## Development

Clone the repository and install dependencies:

```bash
git clone git@github.com:moureau-dev/pipeflow.git
cd pipeflow
bun install
```

Run tests:

```bash
bun test
```

Build and type-check:

```bash
bun run build       # transpile to dist/esm + dist/cjs and emit dist/types
bun run typecheck
```

The project uses Bun and TypeScript.

## Design principles

<details>
<summary>The rules the API is built around: realtime first, provider agnostic, app-owned tools</summary>

### Realtime first

Audio is streamed continuously rather than processed as completed recordings.

### Provider agnostic

STT, LLM, and TTS providers are adapters, not application-level concepts.

### Application-owned tools

Your application executes your tools.

### Conversations are persistent entities

A realtime `Conversation` instance is a runtime handle to a persistent conversation.

### Agents are independent

An agent can participate in a conversation or simply be invoked with `run()`.

### Explicit boundaries

Pipeflow owns orchestration.

Your application owns application logic.

Providers own their respective AI services.

### Small public API

The core API should remain centered around:

```text
Pipeflow
Agent
Conversation
Tool
```

Everything else should remain replaceable implementation detail for as long as possible.

</details>

## License

See [LICENSE](LICENSE).
