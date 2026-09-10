# `@moureau/pipeflow/client`

A small browser/Node SDK for talking to a Pipeflow server.

The client mirrors the `Conversation` event surface over a swappable wire
protocol. It knows nothing about STT/LLM/TTS: it forwards your input and
surfaces what comes back.

## Install

```ts
import { PipeflowClient, WebSocketProtocol } from "@moureau/pipeflow/client";
```

## Quick start

```ts
const client = new PipeflowClient({
  protocol: new WebSocketProtocol({
    url: "wss://api.example.com/conversations/abc",
    token: () => localStorage.getItem("jwt"), // resolved on each connect()
  }),
  audio: { input: true }, // auto-attach the mic
  reconnect: { maxAttempts: 5, initialBackoffMs: 500 },
  userId: "alice",
});

client.on("turn", (e) => log(e.turn.text));
client.on("audio", (e) => client.playAudio(e.audio));
client.on("error", (e) => console.error(e.error));

await client.connect();
await client.sendText("hello"); // bypasses STT
```

## Events

Mirrors `Conversation` over the wire. Subscribed with `client.on(event, listener)`; unsubscribe with the returned function or `client.off(event, listener)`.

| Event | Payload |
|---|---|
| `start` | `{ conversationId }` |
| `stop` | `{ conversationId }` |
| `turn` | `{ conversationId, turn }` |
| `transcript` | `{ conversationId, entry }` |
| `partial-transcript` | `{ conversationId, userId, text }` |
| `audio` | `{ conversationId, audio }` |
| `generation` | `{ conversationId, generation }` |
| `generation-complete` | `{ conversationId, generation }` |
| `text-delta` | `{ conversationId, text, agentName? }` |
| `tool-call` | `{ conversationId, call }` |
| `tool-call-result` | `{ conversationId, result }` |
| `interrupt` | `{ conversationId }` |
| `state` | `{ conversationId, state }` |
| `error` | `{ conversationId?, error }` |

Unknown message types are ignored, so the client stays forward-compatible.

## Outbound

| Method | Equivalent on `Conversation` |
|---|---|
| `client.sendText(text, { userId? })` | `conversation.send({ userId, text })` |
| `client.sendAudio(audio, { userId? })` | `conversation.listen({ userId, audio, sequence })` |
| `client.interrupt({ conversationId? })` | `conversation.interrupt()` |
| `client.resolveToolCall(result, { conversationId? })` | `conversation.resolveToolCall(...)` |
| `client.playAudio(audio)` | default no-op; override to wire your audio sink |

## Audio

There is no `audio: { input, output }` flag pair. Capture is opt-in via
`audio.input: true`; playback is driven by the `audio` event, so you wire
your own `AudioContext` / `<audio>` / queue. `playAudio()` is a default
no-op you can override or replace with a direct `client.on("audio", ...)`
listener.

### Capture gate (`audio.transform`)

`audio.transform` sits between the built-in capture and the wire: the seam
for client-side VAD. Return a chunk to send it (possibly rewritten) or
`null` to drop it. It may be sync or async:

```ts
const client = new PipeflowClient({
  protocol,
  audio: {
    input: true,
    transform: (chunk) => isSpeech(chunk) ? chunk : null, // your VAD
    // or async (Silero in a worker, model inference):
    // transform: async (chunk) => await vad.judge(chunk),
  },
});
```

It applies only to captured mic audio. Manual `sendAudio()` calls hit the
wire untouched: the send path stays a faithful transport, so gating policy
lives only where capture was explicitly opted into. A throwing or rejected
transform emits an `error` event and drops the chunk; the capture loop
keeps running.

**Ordering.** Each chunk's `sequence` is assigned at capture time, before
the transform runs. An async transform sends chunks as they resolve, so
they may hit the wire out of order; the server reorders before STT
(`conversation.listen({ sequence })` + `audioReorderMs`, netcode-style).
Keep the transform faster than the capture rate: a chunk delayed past the
server's hold window is released without its predecessors, so a transform
slower than real-time loses audio at the gaps.

### Capture constraints

The mic opens with `echoCancellation`, `noiseSuppression`, and
`autoGainControl` on by default. Without echo cancellation the speaker's
audio re-enters the mic, the server hears the agent, and barge-in
self-triggers. Override per track constraint with `audio.constraints`:

```ts
audio: { input: true, constraints: { echoCancellation: false } }
```

## Protocols

`Protocol` is a small contract: `connect`, `close`, `send`, `onMessage`,
`onStatus`, plus a `status` getter. The shipped `WebSocketProtocol` is one
implementation. Bring your own:

```ts
class SseProtocol implements Protocol { /* ... */ }

const client = new PipeflowClient({ protocol: new SseProtocol({ url }) });
```

The `WebSocketProtocol` token is appended as `?token=…` on the URL (the
WebSocket spec has no `Authorization` header mechanism). For subprotocols,
use `protocols`. For a custom socket (tests, polyfills), pass `socketFactory`.

## Reconnect

`reconnect.maxAttempts > 0` enables exponential-backoff reconnect on
unexpected close. `client.disconnect()` disables it. The fake-protocol tests
in `client.test.ts` and `protocol/websocket.test.ts` exercise the contract.