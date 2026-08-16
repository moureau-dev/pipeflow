import { describe, expect, test } from "bun:test";
import type { Message } from "../../types.ts";
import { MemoryTransport } from "./memory.ts";

function sampleMessage(overrides: Record<string, unknown> = {}): Message {
  return {
    type: "audio-in",
    conversationId: "conv-1",
    userId: "alice",
    audio: { data: new Uint8Array([1, 2, 3]), timestamp: 100, sequence: 0 },
    ...overrides,
  } as Message;
}

describe("MemoryTransport", () => {
  test("delivers messages sent on one end to listeners on the peer end", () => {
    const [a, b] = MemoryTransport.pair();
    const received: Message[] = [];
    b.onMessage((message) => received.push(message));

    const message = sampleMessage();
    a.send(message);

    expect(received).toEqual([message]);
  });

  test("does not deliver messages to listeners on the sending end", () => {
    const [a, b] = MemoryTransport.pair();
    const receivedOnA: Message[] = [];
    const receivedOnB: Message[] = [];
    a.onMessage((message) => receivedOnA.push(message));
    b.onMessage((message) => receivedOnB.push(message));

    a.send(sampleMessage());

    expect(receivedOnA).toEqual([]);
    expect(receivedOnB).toHaveLength(1);
  });

  test("delivers to every subscribed listener", () => {
    const [a, b] = MemoryTransport.pair();
    const first: Message[] = [];
    const second: Message[] = [];
    b.onMessage((message) => first.push(message));
    b.onMessage((message) => second.push(message));

    a.send(sampleMessage());

    expect(first).toHaveLength(1);
    expect(second).toHaveLength(1);
  });

  test("delivery order matches send order", () => {
    const [a, b] = MemoryTransport.pair();
    const received: Message[] = [];
    b.onMessage((message) => received.push(message));

    a.send(sampleMessage({ type: "interrupt" }));
    a.send(sampleMessage({ type: "audio-in", userId: "bob" }));

    expect(received.map((m) => m.type)).toEqual(["interrupt", "audio-in"]);
  });

  test("a throwing listener does not prevent delivery to other listeners", () => {
    const [a, b] = MemoryTransport.pair();
    const received: Message[] = [];
    b.onMessage(() => {
      throw new Error("listener failure");
    });
    b.onMessage((message) => received.push(message));

    expect(() => a.send(sampleMessage())).not.toThrow();
    expect(received).toHaveLength(1);
  });

  test("unsubscribing stops delivery", () => {
    const [a, b] = MemoryTransport.pair();
    const received: Message[] = [];
    const unsubscribe = b.onMessage((message) => received.push(message));

    a.send(sampleMessage());
    unsubscribe();
    a.send(sampleMessage({ type: "interrupt" }));

    expect(received).toHaveLength(1);
  });

  test("close disconnects both ends of a pair", async () => {
    const [a, b] = MemoryTransport.pair();
    const received: Message[] = [];
    b.onMessage((message) => received.push(message));

    await a.close();

    expect(a.isClosed).toBe(true);
    expect(b.isClosed).toBe(true);
    expect(() => a.send(sampleMessage())).toThrow("closed");
    expect(() => b.send(sampleMessage())).toThrow("closed");
    expect(() => a.onMessage(() => {})).toThrow("closed");
    expect(received).toEqual([]);
  });

  test("closing one end closes the peer and both refuse to send", async () => {
    const [a, b] = MemoryTransport.pair();
    await b.close();
    expect(a.isClosed).toBe(true);
    expect(b.isClosed).toBe(true);
    expect(() => a.send(sampleMessage())).toThrow("closed");
    expect(() => b.send(sampleMessage())).toThrow("closed");
  });

  test("close is idempotent", async () => {
    const [a, b] = MemoryTransport.pair();
    await a.close();
    await a.close();
    await b.close();
    expect(a.isClosed).toBe(true);
    expect(b.isClosed).toBe(true);
  });

  test("an unpaired transport cannot send", () => {
    const transport = new MemoryTransport();
    expect(() => transport.send(sampleMessage())).toThrow("no peer");
  });
});
