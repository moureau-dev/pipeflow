# Transport

Realtime communication between Pipeflow and the application.

A `Transport` is one end of a connection carrying `Message` values — the
application and the Pipeflow runtime each hold one end and exchange audio,
turns, transcripts, and control messages.

```ts
type Message =
  | { type: "audio-in"; conversationId; userId; audio }     // app → pipeflow
  | { type: "audio-out"; conversationId; audio }            // pipeflow → app
  | { type: "transcript"; conversationId; entry }
  | { type: "turn"; conversationId; turn }
  | { type: "interrupt"; conversationId }
  | { type: "start"; conversationId }
  | { type: "stop"; conversationId };

interface Transport {
  send(message: Message): void;
  close(): Promise<void>;
  onMessage(listener: (message: Message) => void): () => void;
}
```

## Adapters

- **Memory** (`MemoryTransport`) — in-process transport for tests and
  development. Always half of a connection: `MemoryTransport.pair()` returns
  two connected ends; messages sent on one end are delivered to the peer's
  listeners.

Status: early development. WebSocket, WebRTC, and other real transports are on
the roadmap — the interface is deliberately small so they slot in as adapters.

See the root [README](../../README.md) for the public API.
