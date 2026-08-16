import { describe, expect, test } from "bun:test";
import { DeepgramSTT, DeepgramSession, type STTSocket } from "./deepgram.ts";
import type { STTSession } from "../../types.ts";

type SentFrame =
  | { kind: "data"; data: string | ArrayBuffer | ArrayBufferView }
  | { kind: "close"; code?: number; reason?: string };

class FakeSocket implements STTSocket {
  readonly sent: SentFrame[] = [];
  private readonly listeners = new Map<string, Set<(event: { data?: unknown; error?: unknown }) => void>>();
  closed = false;

  send(data: string | ArrayBuffer | ArrayBufferView): void {
    if (this.closed) throw new Error("socket closed");
    this.sent.push({ kind: "data", data });
  }

  close(code?: number, reason?: string): void {
    if (this.closed) return;
    this.closed = true;
    this.sent.push({ kind: "close", code, reason });
    this.dispatch("close", {});
  }

  addEventListener(
    type: string,
    listener: (event: { data?: unknown; error?: unknown }) => void,
  ): void {
    let set = this.listeners.get(type);
    if (!set) {
      set = new Set();
      this.listeners.set(type, set);
    }
    set.add(listener);
  }

  open(): void {
    this.dispatch("open", {});
  }

  /** Simulate the server pushing a text frame. */
  receive(text: string): void {
    this.dispatch("message", { data: text });
  }

  /** Simulate the server closing the socket. */
  simulateServerClose(): void {
    this.dispatch("close", {});
  }

  /** Simulate a socket-level error. */
  simulateError(): void {
    this.dispatch("error", { error: new Error("boom") });
  }

  private dispatch(type: string, event: { data?: unknown; error?: unknown }): void {
    for (const listener of [...(this.listeners.get(type) ?? [])]) {
      listener(event);
    }
  }
}

function sentBytes(frame: SentFrame): Uint8Array {
  const data = frame.kind === "data" ? frame.data : new Uint8Array();
  if (typeof data === "string") return new TextEncoder().encode(data);
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
}

function resultsMessage(transcript: string, isFinal: boolean): string {
  return JSON.stringify({
    type: "Results",
    is_final: isFinal,
    channel: { alternatives: [{ transcript }] },
  });
}

function collect(session: STTSession): {
  partials: string[];
  finals: string[];
  errors: Error[];
} {
  const events = { partials: [], finals: [], errors: [] as Error[] };
  session.on("partial", (text) => events.partials.push(text));
  session.on("final", (text) => events.finals.push(text));
  session.on("error", (error) => events.errors.push(error));
  return events;
}

describe("DeepgramSTT", () => {
  test("requires an api key", () => {
    expect(() => new DeepgramSTT({ apiKey: "" })).toThrow(/apiKey/);
  });

  test("opens a socket with the listen URL and credentials", () => {
    let capturedUrl = "";
    const stt = new DeepgramSTT({
      apiKey: "dg-key",
      createSocket: (url) => {
        capturedUrl = url;
        return new FakeSocket();
      },
    });

    stt.start({ language: "en-US" });

    expect(capturedUrl).toContain("wss://api.deepgram.com/v1/listen");
    expect(capturedUrl).toContain("model=nova-3");
    expect(capturedUrl).toContain("token=dg-key");
    expect(capturedUrl).toContain("interim_results=true");
    expect(capturedUrl).toContain("language=en-US");
  });

  test("honors explicit start options over constructor defaults", () => {
    let capturedUrl = "";
    const stt = new DeepgramSTT({
      apiKey: "dg-key",
      model: "nova-2",
      createSocket: (url) => {
        capturedUrl = url;
        return new FakeSocket();
      },
    });

    stt.start({ model: "nova-3", sampleRate: 24000 });

    expect(capturedUrl).toContain("model=nova-3");
    expect(capturedUrl).toContain("sample_rate=24000");
  });

  test("emits partial and final transcripts from Results messages", () => {
    const socket = new FakeSocket();
    const stt = new DeepgramSTT({ apiKey: "dg-key", createSocket: () => socket });
    const session = stt.start();
    socket.open();
    const events = collect(session);

    socket.receive(resultsMessage("hello world", false));
    socket.receive(resultsMessage("hello world", true));
    socket.receive(resultsMessage("how are you", false));

    expect(events.partials).toEqual(["hello world", "how are you"]);
    expect(events.finals).toEqual(["hello world"]);
  });

  test("ignores Results messages with an empty transcript", () => {
    const socket = new FakeSocket();
    const stt = new DeepgramSTT({ apiKey: "dg-key", createSocket: () => socket });
    const session = stt.start();
    socket.open();
    const events = collect(session);

    socket.receive(resultsMessage("", false));
    socket.receive(resultsMessage("", true));

    expect(events.partials).toEqual([]);
    expect(events.finals).toEqual([]);
  });

  test("ignores non-Results message types and malformed frames", () => {
    const socket = new FakeSocket();
    const stt = new DeepgramSTT({ apiKey: "dg-key", createSocket: () => socket });
    const session = stt.start();
    socket.open();
    const events = collect(session);

    socket.receive(JSON.stringify({ type: "Metadata", transaction_key: "abc" }));
    socket.receive("not json at all");

    expect(events.partials).toEqual([]);
    expect(events.finals).toEqual([]);
  });

  test("sends audio written after the socket opens", () => {
    const socket = new FakeSocket();
    const stt = new DeepgramSTT({ apiKey: "dg-key", createSocket: () => socket });
    const session = stt.start();
    socket.open();

    session.write(new Uint8Array([1, 2, 3, 4]));

    expect(socket.sent).toHaveLength(1);
    expect([...sentBytes(socket.sent[0]!)]).toEqual([1, 2, 3, 4]);
  });

  test("queues audio written before the socket opens and flushes it in order", () => {
    const socket = new FakeSocket();
    const stt = new DeepgramSTT({ apiKey: "dg-key", createSocket: () => socket });
    const session = stt.start();

    session.write(new Uint8Array([1]));
    session.write(new Uint8Array([2, 2]));
    expect(socket.sent).toEqual([]);

    socket.open();
    expect(socket.sent).toHaveLength(2);
    expect([...sentBytes(socket.sent[0]!)]).toEqual([1]);
    expect([...sentBytes(socket.sent[1]!)]).toEqual([2, 2]);
  });

  test("slices views so shared buffers are not leaked", () => {
    const socket = new FakeSocket();
    const stt = new DeepgramSTT({ apiKey: "dg-key", createSocket: () => socket });
    const session = stt.start();
    socket.open();

    // The view covers only the middle of a larger buffer.
    const backing = new Uint8Array([9, 9, 7, 7, 9, 9]);
    session.write(backing.subarray(2, 4));

    expect([...sentBytes(socket.sent[0]!)]).toEqual([7, 7]);
  });

  test("end sends CloseStream and resolves when the server closes", async () => {
    const socket = new FakeSocket();
    const stt = new DeepgramSTT({ apiKey: "dg-key", createSocket: () => socket });
    const session = stt.start();
    socket.open();

    const ended = session.end();
    const closeStream = socket.sent.find(
      (frame): frame is { kind: "data"; data: string } =>
        frame.kind === "data" && typeof frame.data === "string",
    );
    expect(JSON.parse(closeStream!.data)).toEqual({ type: "CloseStream" });

    socket.simulateServerClose();
    await ended;
  });

  test("end before the socket opens sends CloseStream after opening", async () => {
    const socket = new FakeSocket();
    const stt = new DeepgramSTT({ apiKey: "dg-key", createSocket: () => socket });
    const session = stt.start();

    session.write(new Uint8Array([1]));
    const ended = session.end();

    socket.open();

    expect(socket.sent).toHaveLength(2);
    expect([...sentBytes(socket.sent[0]!)]).toEqual([1]);
    expect(JSON.parse(String((socket.sent[1] as { data: string }).data))).toEqual({
      type: "CloseStream",
    });

    socket.simulateServerClose();
    await ended;
  });

  test("end is idempotent", async () => {
    const socket = new FakeSocket();
    const stt = new DeepgramSTT({ apiKey: "dg-key", createSocket: () => socket });
    const session = stt.start();
    socket.open();

    const first = session.end();
    const second = session.end();
    expect(socket.sent.filter((f) => f.kind === "data")).toHaveLength(1);

    socket.simulateServerClose();
    await first;
    await second;
  });

  test("write after close throws", async () => {
    const socket = new FakeSocket();
    const stt = new DeepgramSTT({ apiKey: "dg-key", createSocket: () => socket });
    const session = stt.start();
    socket.open();

    socket.simulateServerClose();
    await session.end();
    expect(() => session.write(new Uint8Array([1]))).toThrow(/closed/);
  });

  test("socket errors are surfaced as error events", () => {
    const socket = new FakeSocket();
    const stt = new DeepgramSTT({ apiKey: "dg-key", createSocket: () => socket });
    const session = stt.start();
    const events = collect(session);

    socket.simulateError();

    expect(events.errors).toHaveLength(1);
    expect(events.errors[0]?.message).toContain("socket error");
  });

  test("cancel() aborts every active session", () => {
    const sockets = [new FakeSocket(), new FakeSocket()];
    let index = 0;
    const stt = new DeepgramSTT({
      apiKey: "dg-key",
      createSocket: () => sockets[index++]!,
    });
    stt.start();
    stt.start();

    stt.cancel();

    expect(sockets[0]!.closed).toBe(true);
    expect(sockets[1]!.closed).toBe(true);
  });

  test("cancel() closes a session so subsequent writes fail", () => {
    const socket = new FakeSocket();
    const stt = new DeepgramSTT({ apiKey: "dg-key", createSocket: () => socket });
    const session = stt.start();
    stt.cancel();

    expect(socket.closed).toBe(true);
    expect(() => session.write(new Uint8Array([1]))).toThrow(/closed/);
  });

  test("a session that closes is no longer tracked by cancel()", () => {
    const sockets = [new FakeSocket(), new FakeSocket()];
    let index = 0;
    const stt = new DeepgramSTT({
      apiKey: "dg-key",
      createSocket: () => sockets[index++]!,
    });
    const first = stt.start();
    stt.start();

    // First session ends on its own; cancel should only touch the second.
    sockets[0]!.simulateServerClose();
    first.end();
    stt.cancel();

    expect(sockets[0]!.closed).toBe(false);
    expect(sockets[1]!.closed).toBe(true);
  });

  test("DeepgramSession can be constructed directly with a socket", () => {
    const socket = new FakeSocket();
    const session = new DeepgramSession(socket);
    const events = collect(session);
    socket.open();
    socket.receive(resultsMessage("direct", true));
    expect(events.finals).toEqual(["direct"]);
  });
});
