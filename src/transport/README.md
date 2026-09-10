# Transport

Realtime communication between Pipeflow and the application.

## Low-level transport

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

### Adapters

- **Memory** (`MemoryTransport`) — in-process transport for tests and
  development. Always half of a connection: `MemoryTransport.pair()` returns
  two connected ends; messages sent on one end are delivered to the peer's
  listeners.

## Server transport (Bun-agnostic)

For server deployments, Pipeflow provides a **runtime-independent** server
abstraction. You bring your own WebSocket server (Bun, Node `ws`, socket.io)
via the `ServerAdapter` interface:

```ts
import type { ServerAdapter, ServerClient } from "@moureau/pipeflow/transport";

interface ServerAdapter {
  start(): Promise<void>;
  stop(): Promise<void>;
  onConnection(listener: (client: ServerClient) => void): () => void;
}
```

A `ServerClient` has `send()`, `sendBinary()`, `close()`, `onMessage()`, and
`onClose()` — everything needed to bridge conversation events to a remote
client.

### Adapters

- **Bun** (`BunServerAdapter`) — wraps `Bun.serve()` with WebSocket upgrade.
- **ConversationWebSocketServer** — the high-level bridge that connects a
  Pipeflow `Conversation` to any `ServerAdapter`. It wires conversation events
  (`turn`, `audio`, `transcript`, `interrupt`, etc.) to connected clients and
  forwards incoming messages (`text-in`, `interrupt`, `tool-result`, audio
  binary) back to the conversation.

```ts
import { ConversationWebSocketServer, BunServerAdapter } from "@moureau/pipeflow/transport";

const adapter = new BunServerAdapter({ port: 3000 });
const server = new ConversationWebSocketServer({ conversation, adapter });
await server.start();
```

### Rolling your own adapter

Implement `ServerAdapter` for any runtime:

```ts
class SocketIOServerAdapter implements ServerAdapter {
  private io?: Server;

  async start() {
    this.io = new Server(this.httpServer);
    this.io.on("connection", (socket) => {
      const client: ServerClient = {
        send: (data) => socket.emit("message", data),
        sendBinary: (data) => socket.emit("binary", data),
        close: () => socket.disconnect(),
        onMessage: (listener) => {
          socket.on("message", (data: string) => listener(data));
          return () => socket.off("message");
        },
        onClose: (listener) => {
          socket.on("disconnect", listener);
          return () => socket.off("disconnect", listener);
        },
      };
      this.connectionHandler?.(client);
    });
  }

  async stop() { this.io?.close(); }

  private connectionHandler: ((client: ServerClient) => void) | null = null;
  onConnection(handler: (client: ServerClient) => void) {
    this.connectionHandler = handler;
    return () => { this.connectionHandler = null; };
  }
}
```

## Experimental: streamobject

[`streamobject/`](streamobject/) is a research module, not part of the
`Transport` contract and not exported from the public API. It explores a
schema-bound streaming semantic protocol — a wire codec, an incremental JSON
adapter, and a `FieldStream` semantic API with two source implementations
(`StreamObject` for text-chunk sources, `ConversationStream` in conversations
for conversation events) that turn a source into field/item/object completion
events. It is the natural candidate wire representation for the realtime
transports above, but nothing is integrated yet. See
[`streamobject/README.md`](streamobject/README.md) for the protocol spec.

See the root [README](../../README.md) for the public API.
