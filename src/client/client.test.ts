/**
 * Tests for the Pipeflow client SDK.
 *
 * The client is exercised end-to-end through a `FakeProtocol`, a `Protocol`
 * implementation that lets the test deliver messages synchronously and
 * assert what the client sent. WebSocket behavior is covered separately by
 * `websocket.test.ts`.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { PipeflowClient } from "./client";
import type {
  Protocol,
  ProtocolListener,
  ProtocolMessage,
  ProtocolStatus,
  StatusListener,
} from "./protocol";
import type { AudioChunk, Generation, Turn } from "../conversations/types";

class FakeProtocol implements Protocol {
  private _status: ProtocolStatus = "idle";
  private readonly sent: ProtocolMessage[] = [];
  private readonly messageListeners = new Set<ProtocolListener>();
  private readonly statusListeners = new Set<StatusListener>();

  /** If set, `connect()` rejects with this error. */
  connectError: Error | null = null;

  get status(): ProtocolStatus {
    return this._status;
  }

  sentMessages(): readonly ProtocolMessage[] {
    return this.sent;
  }

  async connect(): Promise<void> {
    if (this._status === "open" || this._status === "connecting") return;
    if (this.connectError) {
      const err = this.connectError;
      this.connectError = null;
      throw err;
    }
    this.setStatus("connecting");
    this.setStatus("open");
  }

  async close(): Promise<void> {
    if (this._status === "closed") return;
    this.setStatus("closing");
    this.setStatus("closed");
  }

  send(message: ProtocolMessage): void {
    if (this._status !== "open") {
      throw new Error(`Cannot send on a ${this._status} protocol`);
    }
    this.sent.push(message);
  }

  onMessage(listener: ProtocolListener): () => void {
    this.messageListeners.add(listener);
    return () => {
      this.messageListeners.delete(listener);
    };
  }

  onStatus(listener: StatusListener): () => void {
    this.statusListeners.add(listener);
    return () => {
      this.statusListeners.delete(listener);
    };
  }

  /** Test helper: deliver a message as if it came from the server. */
  deliver(message: ProtocolMessage): void {
    for (const l of [...this.messageListeners]) {
      try {
        l(message);
      } catch {
        // ignore
      }
    }
  }

  /** Test helper: simulate a server-initiated drop. */
  drop(): void {
    if (this._status === "closed") return;
    this.setStatus("closed");
  }

  private setStatus(next: ProtocolStatus): void {
    if (this._status === next) return;
    this._status = next;
    for (const l of [...this.statusListeners]) {
      try {
        l(next);
      } catch {
        // ignore
      }
    }
  }
}

function makeTurn(overrides: Partial<Turn> = {}): Turn {
  return {
    id: "turn-1",
    conversationId: "conv-1",
    participantId: "alice",
    participantName: "Alice",
    text: "hello",
    sequence: 0,
    startedAt: 1,
    endedAt: 2,
    ...overrides,
  };
}

function makeGeneration(overrides: Partial<Generation> = {}): Generation {
  return {
    id: "gen-1",
    conversationId: "conv-1",
    agentName: "Scout",
    text: "hi",
    status: "streaming",
    startedAt: 1,
    ...overrides,
  };
}

function makeAudio(overrides: Partial<AudioChunk> = {}): AudioChunk {
  return {
    data: new Uint8Array([1, 2, 3]),
    timestamp: 1,
    sequence: 0,
    ...overrides,
  };
}

let proto: FakeProtocol;
let client: PipeflowClient;

beforeEach(() => {
  proto = new FakeProtocol();
  client = new PipeflowClient({ protocol: proto });
});

afterEach(async () => {
  await client.disconnect();
});

describe("PipeflowClient lifecycle", () => {
  test("connect() opens the protocol and accepts start event", async () => {
    const seen: unknown[] = [];
    client.on("start", (e) => seen.push(e));
    await client.connect();
    proto.deliver({ type: "start", payload: { conversationId: "conv-1" } });
    expect(seen).toEqual([{ conversationId: "conv-1" }]);
  });

  test("disconnect() closes the protocol", async () => {
    await client.connect();
    await client.disconnect();
    expect(proto.status).toBe("closed");
  });

  test("connect() is idempotent while already open", async () => {
    await client.connect();
    await client.connect();
    expect(proto.status).toBe("open");
  });
});

describe("PipeflowClient outbound", () => {
  test("sendText() emits a text-in message", async () => {
    await client.connect();
    client.sendText("hello");
    expect(proto.sentMessages()).toEqual([
      { type: "text-in", payload: { userId: "anonymous", text: "hello" } },
    ]);
  });

  test("sendText() honors an explicit userId", async () => {
    await client.connect();
    client.sendText("hi", { userId: "alice" });
    expect(proto.sentMessages()[0]?.payload).toMatchObject({ userId: "alice" });
  });

  test("sendText() before connect() surfaces an error and does not throw", async () => {
    const errors: Error[] = [];
    client.on("error", (e) => errors.push(e.error));
    client.sendText("hi");
    expect(errors).toHaveLength(1);
    expect(errors[0]?.message).toContain("idle");
  });

  test("sendAudio() forwards chunks with a sequence", async () => {
    await client.connect();
    client.sendAudio(makeAudio());
    client.sendAudio(makeAudio({ sequence: 7 }));
    expect(proto.sentMessages()[0]?.payload).toMatchObject({ sequence: 0 });
    expect(proto.sentMessages()[1]?.payload).toMatchObject({ sequence: 7 });
  });

  test("interrupt() emits an interrupt message", async () => {
    await client.connect();
    client.interrupt();
    expect(proto.sentMessages()).toEqual([
      { type: "interrupt", payload: { conversationId: null } },
    ]);
  });

  test("resolveToolCall() emits a tool-result message", async () => {
    await client.connect();
    const result = { id: "call-1", result: { ok: true } };
    client.resolveToolCall(result);
    expect(proto.sentMessages()[0]).toEqual({
      type: "tool-result",
      payload: { conversationId: null, result },
    });
  });
});

describe("PipeflowClient inbound", () => {
  test("forwards every supported message to the matching event", async () => {
    await client.connect();
    const events: string[] = [];
    for (const e of [
      "turn",
      "transcript",
      "audio",
      "generation",
      "tool-call",
      "interrupt",
      "stop",
      "partial-transcript",
      "state",
      "tool-call-result",
    ] as const) {
      client.on(e, () => events.push(e));
    }
    proto.deliver({ type: "turn", payload: { conversationId: "c", turn: makeTurn() } });
    proto.deliver({
      type: "transcript",
      payload: {
        conversationId: "c",
        entry: {
          id: "t1",
          conversationId: "c",
          kind: "user",
          speakerId: "alice",
          speakerName: "Alice",
          text: "hi",
          startedAt: 1,
          endedAt: 2,
        },
      },
    });
    proto.deliver({ type: "audio", payload: { conversationId: "c", audio: makeAudio() } });
    proto.deliver({ type: "generation", payload: { conversationId: "c", generation: makeGeneration() } });
    proto.deliver({
      type: "tool-call",
      payload: {
        conversationId: "c",
        call: { id: "call-1", name: "get_weather", arguments: { city: "SP" } },
      },
    });
    proto.deliver({
      type: "tool-call-result",
      payload: { conversationId: "c", result: { id: "call-1", result: { temp: 25 } } },
    });
    proto.deliver({ type: "interrupt", payload: { conversationId: "c" } });
    proto.deliver({ type: "stop", payload: { conversationId: "c" } });
    proto.deliver({
      type: "partial-transcript",
      payload: { conversationId: "c", userId: "alice", text: "hel…" },
    });
    proto.deliver({ type: "state", payload: { conversationId: "c", state: { status: "started" } } });
    expect(events).toEqual([
      "turn",
      "transcript",
      "audio",
      "generation",
      "tool-call",
      "tool-call-result",
      "interrupt",
      "stop",
      "partial-transcript",
      "state",
    ]);
  });

  test("server error message becomes an Error event", async () => {
    await client.connect();
    const errors: Error[] = [];
    client.on("error", (e) => errors.push(e.error));
    proto.deliver({ type: "error", payload: { message: "boom" } });
    expect(errors).toHaveLength(1);
    expect(errors[0]?.message).toBe("boom");
  });

  test("unknown message types are ignored", async () => {
    await client.connect();
    let called = false;
    client.on("turn", () => (called = true));
    proto.deliver({ type: "future-event", payload: { whatever: 1 } });
    expect(called).toBe(false);
  });

  test("a faulty listener does not block the others", async () => {
    await client.connect();
    let secondCalled = false;
    client.on("turn", () => {
      throw new Error("listener boom");
    });
    client.on("turn", () => (secondCalled = true));
    proto.deliver({ type: "turn", payload: { conversationId: "c", turn: makeTurn() } });
    expect(secondCalled).toBe(true);
  });
});

describe("PipeflowClient auto-reconnect", () => {
  test("reconnects with exponential backoff after an unexpected drop", async () => {
    const reconnecting = new PipeflowClient({
      protocol: proto,
      reconnect: { maxAttempts: 3, initialBackoffMs: 10, maxBackoffMs: 40 },
    });
    await reconnecting.connect();
    proto.drop();
    // First attempt at 10ms; the test waits long enough for it to fire and
    // for connect() (which on the Fake is synchronous-success) to re-open.
    await new Promise((r) => setTimeout(r, 100));
    expect(proto.status).toBe("open");
    await reconnecting.disconnect();
  });

  test("user-initiated disconnect disables reconnect", async () => {
    const reconnecting = new PipeflowClient({
      protocol: proto,
      reconnect: { maxAttempts: 5, initialBackoffMs: 5, maxBackoffMs: 5 },
    });
    await reconnecting.connect();
    await reconnecting.disconnect();
    expect(reconnecting["reconnectTimer"]).toBeNull();
  });
});

describe("PipeflowClient events API", () => {
  test("on() returns an unsubscribe function", async () => {
    await client.connect();
    let calls = 0;
    const off = client.on("interrupt", () => calls++);
    proto.deliver({ type: "interrupt", payload: { conversationId: "c" } });
    off();
    proto.deliver({ type: "interrupt", payload: { conversationId: "c" } });
    expect(calls).toBe(1);
  });

  test("off() removes a listener", async () => {
    await client.connect();
    let calls = 0;
    const handler = () => calls++;
    client.on("stop", handler);
    client.off("stop", handler);
    proto.deliver({ type: "stop", payload: { conversationId: "c" } });
    expect(calls).toBe(0);
  });
});

// -----------------------------------------------------------------------------
// Mic capture (browser globals)
// -----------------------------------------------------------------------------

type DataAvailableListener = (event: {
  data: { size: number; arrayBuffer(): Promise<ArrayBuffer> };
}) => void;

/** Minimal stand-in for the browser `MediaRecorder`. */
class FakeMediaRecorder {
  static instances: FakeMediaRecorder[] = [];

  state = "inactive";
  startedWith: number | null = null;
  private listener: DataAvailableListener | null = null;

  constructor(public stream: unknown) {
    FakeMediaRecorder.instances.push(this);
  }

  addEventListener(_type: "dataavailable", listener: DataAvailableListener): void {
    this.listener = listener;
  }

  start(timeslice: number): void {
    this.state = "recording";
    this.startedWith = timeslice;
  }

  stop(): void {
    this.state = "inactive";
  }

  /** Test helper: emit a captured chunk as a MediaRecorder would. */
  emit(bytes: Uint8Array): void {
    const data = {
      size: bytes.byteLength,
      arrayBuffer: async () => bytes.buffer as ArrayBuffer,
    };
    this.listener?.({ data });
  }
}

const originalNavigatorDescriptor = Object.getOwnPropertyDescriptor(globalThis, "navigator");
const originalMediaRecorderDescriptor = Object.getOwnPropertyDescriptor(
  globalThis,
  "MediaRecorder",
);

function installBrowserGlobals(): {
  gumConstraints: Array<unknown>;
  state: { stoppedTracks: number };
} {
  const gumConstraints: Array<unknown> = [];
  const state = { stoppedTracks: 0 };
  const getUserMedia = async (constraints: unknown) => {
    gumConstraints.push(constraints);
    return {
      getTracks: () => [
        {
          stop: () => {
            state.stoppedTracks++;
          },
        },
      ],
    };
  };
  Object.defineProperty(globalThis, "navigator", {
    value: { mediaDevices: { getUserMedia } },
    configurable: true,
  });
  Object.defineProperty(globalThis, "MediaRecorder", {
    value: FakeMediaRecorder,
    configurable: true,
  });
  return { gumConstraints, state };
}

function restoreBrowserGlobals(): void {
  if (originalNavigatorDescriptor) {
    Object.defineProperty(globalThis, "navigator", originalNavigatorDescriptor);
  } else {
    delete (globalThis as unknown as Record<string, unknown>).navigator;
  }
  if (originalMediaRecorderDescriptor) {
    Object.defineProperty(globalThis, "MediaRecorder", originalMediaRecorderDescriptor);
  } else {
    delete (globalThis as unknown as Record<string, unknown>).MediaRecorder;
  }
}

function flushMicrotasks(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

describe("PipeflowClient mic capture", () => {
  let browser: ReturnType<typeof installBrowserGlobals>;

  beforeEach(() => {
    FakeMediaRecorder.instances = [];
    browser = installBrowserGlobals();
  });

  afterEach(() => {
    restoreBrowserGlobals();
  });

  test("startMic opens the mic with echo cancellation on by default", async () => {
    const mic = new PipeflowClient({ protocol: proto, audio: { input: true } });
    await mic.connect();
    const recorder = FakeMediaRecorder.instances[0]!;
    expect(recorder).toBeDefined();
    expect(browser.gumConstraints[0]).toEqual({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
    expect(recorder.startedWith).toBe(250);
    await mic.disconnect();
    expect(browser.state.stoppedTracks).toBe(1);
  });

  test("audio.constraints override the defaults", async () => {
    const mic = new PipeflowClient({
      protocol: proto,
      audio: { input: true, constraints: { echoCancellation: false } },
    });
    await mic.connect();
    expect(browser.gumConstraints[0]).toEqual({
      audio: { echoCancellation: false, noiseSuppression: true, autoGainControl: true },
    });
    await mic.disconnect();
  });

  test("concurrent connect() calls open the mic once", async () => {
    const mic = new PipeflowClient({ protocol: proto, audio: { input: true } });
    await Promise.all([mic.connect(), mic.connect()]);
    expect(browser.gumConstraints).toHaveLength(1);
    expect(FakeMediaRecorder.instances).toHaveLength(1);
    await mic.disconnect();
  });

  test("audio.transform can gate captured chunks", async () => {
    const mic = new PipeflowClient({
      protocol: proto,
      audio: {
        input: true,
        transform: (chunk) => (chunk.data.length > 2 ? chunk : null),
      },
    });
    await mic.connect();
    const recorder = FakeMediaRecorder.instances[0]!;
    recorder.emit(new Uint8Array([1])); // gated: below the fake VAD threshold
    recorder.emit(new Uint8Array([1, 2, 3])); // passes
    await flushMicrotasks();
    const audioIn = proto.sentMessages().filter((m) => m.type === "audio-in");
    expect(audioIn).toHaveLength(1);
    await mic.disconnect();
  });

  test("audio.transform can rewrite captured chunks", async () => {
    const mic = new PipeflowClient({
      protocol: proto,
      audio: {
        input: true,
        transform: (chunk) => ({ ...chunk, data: new Uint8Array([9]) }),
      },
    });
    await mic.connect();
    FakeMediaRecorder.instances[0]!.emit(new Uint8Array([1, 2, 3]));
    await flushMicrotasks();
    const sent = proto.sentMessages().find((m) => m.type === "audio-in");
    expect((sent?.payload as { audio: { data: Uint8Array } }).audio.data).toEqual(
      new Uint8Array([9]),
    );
    await mic.disconnect();
  });

  test("a throwing transform emits an error and drops the chunk", async () => {
    const errors: Error[] = [];
    const mic = new PipeflowClient({
      protocol: proto,
      audio: {
        input: true,
        transform: () => {
          throw new Error("vad boom");
        },
      },
    });
    mic.on("error", (e) => errors.push(e.error));
    await mic.connect();
    FakeMediaRecorder.instances[0]!.emit(new Uint8Array([1, 2, 3]));
    await flushMicrotasks();
    expect(errors.map((e) => e.message)).toEqual(["vad boom"]);
    expect(proto.sentMessages()).toHaveLength(0);
    await mic.disconnect();
  });

  test("audio.transform may be async", async () => {
    const mic = new PipeflowClient({
      protocol: proto,
      audio: {
        input: true,
        transform: async (chunk) => (chunk.data.length > 2 ? chunk : null),
      },
    });
    await mic.connect();
    const recorder = FakeMediaRecorder.instances[0]!;
    recorder.emit(new Uint8Array([1])); // gated
    recorder.emit(new Uint8Array([1, 2, 3])); // passes
    await flushMicrotasks();
    const audioIn = proto.sentMessages().filter((m) => m.type === "audio-in");
    expect(audioIn).toHaveLength(1);
    await mic.disconnect();
  });

  test("async chunks carry capture-order sequence even when sent out of order", async () => {
    const gate: { release: (() => void) | null } = { release: null };
    const mic = new PipeflowClient({
      protocol: proto,
      audio: {
        input: true,
        transform: (chunk) => {
          if (chunk.sequence === 0) {
            return new Promise<AudioChunk | null>((resolve) => {
              gate.release = () => resolve(chunk);
            });
          }
          return chunk; // chunk 1 passes immediately
        },
      },
    });
    await mic.connect();
    const recorder = FakeMediaRecorder.instances[0]!;
    recorder.emit(new Uint8Array([1])); // seq 0, held by the fake VAD
    recorder.emit(new Uint8Array([2])); // seq 1, passes first
    await flushMicrotasks();
    gate.release?.(); // seq 0 resolves last
    await flushMicrotasks();
    const sequences = proto
      .sentMessages()
      .filter((m) => m.type === "audio-in")
      .map((m) => (m.payload as { sequence: number }).sequence);
    // Sent order [1, 0]; each message still marks its capture position.
    expect(sequences).toEqual([1, 0]);
    await mic.disconnect();
  });

  test("sendAudio() is not gated by audio.transform", async () => {
    const mic = new PipeflowClient({
      protocol: proto,
      audio: { input: true, transform: () => null },
    });
    await mic.connect();
    mic.sendAudio(makeAudio());
    expect(proto.sentMessages()[0]?.type).toBe("audio-in");
    await mic.disconnect();
  });
});