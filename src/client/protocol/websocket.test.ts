/**
 * Tests for `WebSocketProtocol`.
 *
 * Uses a fake `WebSocket` constructor to deterministically drive open /
 * close / error transitions. Verifies status reporting, JSON serialization,
 * and that a token-resolver is consulted on each `connect()`.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { WebSocketProtocol } from "./websocket";
import type { ProtocolStatus } from "../protocol";

class FakeWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;

  readyState = FakeWebSocket.CONNECTING;
  url: string;
  protocols?: string | string[];
  sent: string[] = [];

  private listeners = new Map<string, Set<(event: unknown) => void>>();

  constructor(url: string, protocols?: string | string[]) {
    this.url = url;
    this.protocols = protocols;
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(_code?: number, _reason?: string): void {
    this.readyState = FakeWebSocket.CLOSED;
    this.dispatch("close", {});
  }

  // Test helpers ------------------------------------------------------

  open(): void {
    this.readyState = FakeWebSocket.OPEN;
    this.dispatch("open", {});
  }

  fail(message: string): void {
    this.readyState = FakeWebSocket.CLOSED;
    this.dispatch("error", { message });
  }

  receive(type: string, data: string): void {
    this.dispatch("message", { data });
  }

  on(event: string, listener: (event: unknown) => void): () => void {
    let set = this.listeners.get(event);
    if (!set) {
      set = new Set();
      this.listeners.set(event, set);
    }
    set.add(listener);
    return () => {
      set!.delete(listener);
    };
  }

  addEventListener(event: string, listener: (event: unknown) => void): void {
    this.on(event, listener);
  }

  removeEventListener(event: string, listener: (event: unknown) => void): void {
    this.listeners.get(event)?.delete(listener);
  }

  private dispatch(event: string, payload: unknown): void {
    for (const l of [...(this.listeners.get(event) ?? [])]) {
      l(payload);
    }
  }
}

let lastSocket: FakeWebSocket | null = null;
let factoryCalls = 0;

beforeEach(() => {
  lastSocket = null;
  factoryCalls = 0;
});

afterEach(() => {
  lastSocket = null;
});

describe("WebSocketProtocol", () => {
  function makeSocket(url: string, protocols?: string | string[]) {
    factoryCalls++;
    const socket = new FakeWebSocket(url, protocols);
    lastSocket = socket;
    return socket as unknown as WebSocket;
  }

  test("connect() resolves on open and transitions through connecting → open", async () => {
    const proto = new WebSocketProtocol({
      url: "wss://example.com/c",
      socketFactory: makeSocket,
    });
    const statuses: ProtocolStatus[] = [];
    proto.onStatus((s) => statuses.push(s));
    const connect = proto.connect();
    expect(proto.status).toBe("connecting");
    lastSocket!.open();
    await connect;
    expect(proto.status).toBe("open");
    expect(statuses).toEqual(["connecting", "open"]);
  });

  test("connect() rejects on socket error", async () => {
    const proto = new WebSocketProtocol({
      url: "wss://example.com/c",
      socketFactory: makeSocket,
    });
    const connect = proto.connect();
    lastSocket!.fail("denied");
    await expect(connect).rejects.toThrow(/Failed to connect/);
    expect(proto.status).toBe("closed");
  });

  test("connect() is idempotent while open", async () => {
    const proto = new WebSocketProtocol({
      url: "wss://example.com/c",
      socketFactory: makeSocket,
    });
    const connect = proto.connect();
    lastSocket!.open();
    await connect;
    await proto.connect();
    expect(factoryCalls).toBe(1);
  });

  test("token is appended to the URL on connect()", async () => {
    let tokenCalls = 0;
    const tokens = ["t-1", "t-2"];
    const proto = new WebSocketProtocol({
      url: "wss://example.com/c",
      socketFactory: makeSocket,
      token: () => tokens[tokenCalls++] ?? null,
    });
    const first = proto.connect();
    await Promise.resolve(); // let the synchronous microtask run so the socket is built
    lastSocket!.open();
    await first;
    expect(tokenCalls).toBe(1);
    expect(lastSocket!.url).toBe("wss://example.com/c?token=t-1");

    await proto.close();

    const second = proto.connect();
    await Promise.resolve();
    lastSocket!.open();
    await second;
    expect(tokenCalls).toBe(2);
    expect(lastSocket!.url).toBe("wss://example.com/c?token=t-2");
    await proto.close();
  });

  test("token replaces any existing ?token= query", async () => {
    const proto = new WebSocketProtocol({
      url: "wss://example.com/c?token=stale&room=1",
      socketFactory: makeSocket,
      token: () => "fresh",
    });
    const connect = proto.connect();
    await Promise.resolve();
    lastSocket!.open();
    await connect;
    expect(lastSocket!.url).toBe("wss://example.com/c?token=fresh&room=1");
    await proto.close();
  });

  test("send() serializes JSON and rejects before open", async () => {
    const proto = new WebSocketProtocol({
      url: "wss://example.com/c",
      socketFactory: makeSocket,
    });
    expect(() => proto.send({ type: "ping", payload: { ok: true } })).toThrow();
    const connect = proto.connect();
    lastSocket!.open();
    await connect;
    proto.send({ type: "ping", payload: { ok: true } });
    expect(lastSocket!.sent).toEqual([JSON.stringify({ type: "ping", payload: { ok: true } })]);
    await proto.close();
  });

  test("send() rejects non-JSON payloads", async () => {
    const proto = new WebSocketProtocol({
      url: "wss://example.com/c",
      socketFactory: makeSocket,
    });
    const connect = proto.connect();
    lastSocket!.open();
    await connect;
    // Functions are not JSON-serializable.
    expect(() =>
      proto.send({ type: "x", payload: { fn: () => undefined } }),
    ).toThrow(/JSON/);
    await proto.close();
  });

  test("incoming JSON messages are dispatched to listeners", async () => {
    const proto = new WebSocketProtocol({
      url: "wss://example.com/c",
      socketFactory: makeSocket,
    });
    const connect = proto.connect();
    lastSocket!.open();
    await connect;
    const received: unknown[] = [];
    proto.onMessage((m) => received.push(m));
    lastSocket!.receive("message", JSON.stringify({ type: "turn", payload: { x: 1 } }));
    lastSocket!.receive("message", "not-json");
    expect(received).toEqual([{ type: "turn", payload: { x: 1 } }]);
    await proto.close();
  });

  test("close() resolves and transitions to closed", async () => {
    const proto = new WebSocketProtocol({
      url: "wss://example.com/c",
      socketFactory: makeSocket,
    });
    const connect = proto.connect();
    lastSocket!.open();
    await connect;
    await proto.close();
    expect(proto.status).toBe("closed");
  });

  test("server-initiated close transitions to closed", async () => {
    const proto = new WebSocketProtocol({
      url: "wss://example.com/c",
      socketFactory: makeSocket,
    });
    const connect = proto.connect();
    lastSocket!.open();
    await connect;
    const statuses: ProtocolStatus[] = [];
    proto.onStatus((s) => statuses.push(s));
    lastSocket!.close();
    expect(proto.status).toBe("closed");
    expect(statuses).toContain("closed");
  });
});