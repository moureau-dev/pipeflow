import { describe, expect, test } from "bun:test";
import { ConversationWebSocketServer } from "./websocket-server";
import type { ServerAdapter, ServerClient } from "../../types";

interface TestClient extends ServerClient {
  sentText: string[];
  sentBinary: Uint8Array[];
  dispatchMessage(data: string): void;
  dispatchBinary(data: Uint8Array): void;
  dispatchClose(): void;
}

function createMockConversation() {
  const handlers = new Map<string, Set<(payload: unknown) => void>>();
  return {
    id: "test-conv",
    on(event: string, listener: (payload: unknown) => void) {
      let set = handlers.get(event);
      if (!set) {
        set = new Set();
        handlers.set(event, set);
      }
      set.add(listener);
      return () => set!.delete(listener);
    },
    send: (_input: { userId: string; text: string }) => {},
    interrupt: () => {},
    resolveToolCall: (_result: unknown) => {},
    listen: (_input: { userId: string; audio: Uint8Array }) => {},
    participate: () => Promise.resolve(),
    emit(event: string, payload: unknown) {
      const set = handlers.get(event);
      if (set) for (const listener of [...set]) listener(payload);
    },
  };
}

function createTestClient(): TestClient {
  const messageListeners = new Set<(data: string | Uint8Array) => void>();
  const closeListeners = new Set<() => void>();
  const sentText: string[] = [];
  const sentBinary: Uint8Array[] = [];

  return {
    send(data: string) { sentText.push(data); },
    sendBinary(data: Uint8Array) { sentBinary.push(data); },
    close() {},
    onMessage(listener) {
      messageListeners.add(listener);
      return () => messageListeners.delete(listener);
    },
    onClose(listener) {
      closeListeners.add(listener);
      return () => closeListeners.delete(listener);
    },
    dispatchMessage(data: string) {
      for (const listener of [...messageListeners]) listener(data);
    },
    dispatchBinary(data: Uint8Array) {
      for (const listener of [...messageListeners]) listener(data);
    },
    dispatchClose() {
      for (const listener of [...closeListeners]) listener();
    },
    sentText,
    sentBinary,
  };
}

function createMockAdapter() {
  let handler: ((client: ServerClient) => void) | null = null;
  return {
    onConnection(h: (client: ServerClient) => void) {
      handler = h;
      return () => { handler = null; };
    },
    get connectionHandler() { return handler; },
    async start() {},
    async stop() {},
  };
}

describe("ConversationWebSocketServer", () => {
  test("binds conversation events and forwards them to connected clients", async () => {
    const conversation = createMockConversation();
    const adapter = createMockAdapter();
    const server = new ConversationWebSocketServer({ conversation: conversation as never, adapter });

    await server.start();
    const client = createTestClient();
    (adapter as unknown as { connectionHandler: (c: ServerClient) => void }).connectionHandler(client);

    conversation.emit("turn", { conversationId: "test-conv", turn: { id: "t1", text: "hi" } });
    conversation.emit("state", { conversationId: "test-conv", state: {} });

    expect(client.sentText.length).toBeGreaterThanOrEqual(2);
    const turnMsg = JSON.parse(client.sentText[0]!);
    expect(turnMsg.type).toBe("turn");

    await server.stop();
  });

  test("forwards text-in messages to conversation.send", async () => {
    const conversation = createMockConversation();
    const adapter = createMockAdapter();
    let received = "";
    conversation.send = ({ text }: { text: string }) => { received = text; };

    const server = new ConversationWebSocketServer({ conversation: conversation as never, adapter });
    await server.start();

    const client = createTestClient();
    (adapter as unknown as { connectionHandler: (c: ServerClient) => void }).connectionHandler(client);
    client.dispatchMessage(JSON.stringify({ type: "text-in", payload: { text: "hello" } }));

    expect(received).toBe("hello");
    await server.stop();
  });

  test("forwards interrupt to conversation.interrupt", async () => {
    const conversation = createMockConversation();
    const adapter = createMockAdapter();
    let interrupted = false;
    conversation.interrupt = () => { interrupted = true; };

    const server = new ConversationWebSocketServer({ conversation: conversation as never, adapter });
    await server.start();

    const client = createTestClient();
    (adapter as unknown as { connectionHandler: (c: ServerClient) => void }).connectionHandler(client);
    client.dispatchMessage(JSON.stringify({ type: "interrupt" }));

    expect(interrupted).toBe(true);
    await server.stop();
  });

  test("forwards tool-result to conversation.resolveToolCall", async () => {
    const conversation = createMockConversation();
    const adapter = createMockAdapter();
    let resolved: unknown = null;
    conversation.resolveToolCall = (result) => { resolved = result; };

    const server = new ConversationWebSocketServer({ conversation: conversation as never, adapter });
    await server.start();

    const client = createTestClient();
    (adapter as unknown as { connectionHandler: (c: ServerClient) => void }).connectionHandler(client);
    client.dispatchMessage(JSON.stringify({ type: "tool-result", payload: { result: { id: "call-1", result: "done" } } }));

    expect(resolved).toEqual({ id: "call-1", result: "done" });
    await server.stop();
  });

  test("ignores unknown message types", async () => {
    const conversation = createMockConversation();
    const adapter = createMockAdapter();
    let called = false;
    conversation.send = () => { called = true; };

    const server = new ConversationWebSocketServer({ conversation: conversation as never, adapter });
    await server.start();

    const client = createTestClient();
    (adapter as unknown as { connectionHandler: (c: ServerClient) => void }).connectionHandler(client);
    client.dispatchMessage(JSON.stringify({ type: "unknown-type", payload: { text: "hello" } }));

    expect(called).toBe(false);
    await server.stop();
  });

  test("ignores malformed JSON messages", async () => {
    const conversation = createMockConversation();
    const adapter = createMockAdapter();
    let called = false;
    conversation.send = () => { called = true; };

    const server = new ConversationWebSocketServer({ conversation: conversation as never, adapter });
    await server.start();

    const client = createTestClient();
    (adapter as unknown as { connectionHandler: (c: ServerClient) => void }).connectionHandler(client);
    client.dispatchMessage("not json");

    expect(called).toBe(false);
    await server.stop();
  });

  test("start and stop are idempotent", async () => {
    const conversation = createMockConversation();
    const server = new ConversationWebSocketServer({ conversation: conversation as never, adapter: createMockAdapter() });

    await server.start();
    await server.start();
    await server.stop();
    await server.stop();
  });

  test("binary audio messages are sent to conversation.listen", async () => {
    const conversation = createMockConversation();
    const adapter = createMockAdapter();
    let receivedAudio: Uint8Array | null = null;
    conversation.listen = ({ audio }) => { receivedAudio = audio; };

    const server = new ConversationWebSocketServer({ conversation: conversation as never, adapter });
    await server.start();

    const client = createTestClient();
    (adapter as unknown as { connectionHandler: (c: ServerClient) => void }).connectionHandler(client);
    const audio = new Uint8Array([1, 2, 3]);
    client.dispatchBinary(audio);

    expect(receivedAudio!).toBe(audio);
    await server.stop();
  });
});