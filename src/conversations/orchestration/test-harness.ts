// Shared test doubles and harnesses for the orchestrator integration suites.
// Import from here rather than re-implementing fakes per test file.

import { Agent } from "../../agents/agent";
import { Tool } from "../../agents/tools/tools";
import { Conversation } from "../conversation/conversation";
import { MemoryPersistence } from "../../persistence/adapters/memory/memory";
import { Orchestrator } from "./orchestrator/orchestrator";
import type { HistoryWindow } from "./orchestrator/history/history";
import type {
  LLM,
  LLMEvent,
  LLMRequest,
} from "../../providers/llm/types";
import type { STT, STTOptions, STTSession } from "../../providers/stt/types";
import type { TTS, TTSRequest } from "../../providers/tts/types";

// ---------------------------------------------------------------------------
// Fake providers
// ---------------------------------------------------------------------------

export type LLMScript = (request: LLMRequest, signal: AbortSignal) => AsyncIterable<LLMEvent>;

export class FakeLLM implements LLM {
  readonly requests: LLMRequest[] = [];
  readonly stopCalls: number[] = [];
  private readonly controllers = new Set<AbortController>();

  constructor(private readonly script: LLMScript) {}

  async *stream(request: LLMRequest): AsyncGenerator<LLMEvent> {
    const controller = new AbortController();
    this.controllers.add(controller);
    this.requests.push(request);
    try {
      for await (const event of this.script(request, controller.signal)) {
        if (controller.signal.aborted) {
          throw new DOMException("The operation was aborted.", "AbortError");
        }
        yield event;
      }
    } finally {
      this.controllers.delete(controller);
    }
  }

  stop(): void {
    this.stopCalls.push(Date.now());
    for (const controller of this.controllers) controller.abort();
  }
}

export class FakeSTT implements STT {
  readonly sessions: FakeSTTSession[] = [];
  readonly startOptions: STTOptions[] = [];

  start(options: STTOptions = {}): FakeSTTSession {
    const session = new FakeSTTSession();
    this.sessions.push(session);
    this.startOptions.push(options);
    return session;
  }

  cancel(): void {}
}

export type FakeSessionEvent = "partial" | "final" | "error";

export class FakeSTTSession implements STTSession {
  readonly written: Uint8Array[] = [];
  ended = 0;
  private readonly listeners: Record<
    FakeSessionEvent,
    Set<(...args: any[]) => void>
  > = {
    partial: new Set(),
    final: new Set(),
    error: new Set(),
  };

  write(audio: Uint8Array): void {
    this.written.push(audio);
  }

  async end(): Promise<void> {
    this.ended++;
  }

  on(event: "partial", listener: (transcript: string) => void): void;
  on(event: "final", listener: (transcript: string) => void): void;
  on(event: "error", listener: (error: Error) => void): void;
  on(event: FakeSessionEvent, listener: (...args: any[]) => void): void {
    this.listeners[event].add(listener);
  }

  emitPartial(text: string): void {
    for (const listener of this.listeners.partial) listener(text);
  }

  emitFinal(text: string): void {
    for (const listener of this.listeners.final) listener(text);
  }

  emitError(error: Error): void {
    for (const listener of this.listeners.error) listener(error);
  }
}

export class FakeTTS implements TTS {
  readonly requests: TTSRequest[] = [];
  private readonly controllers = new Set<AbortController>();

  constructor(private readonly chunksFor: (text: string) => Uint8Array[]) {}

  async *stream(request: TTSRequest): AsyncGenerator<Uint8Array> {
    this.requests.push(request);
    const controller = new AbortController();
    this.controllers.add(controller);
    try {
      for (const chunk of this.chunksFor(request.text)) {
        if (controller.signal.aborted) {
          throw new DOMException("The operation was aborted.", "AbortError");
        }
        yield chunk;
      }
    } finally {
      this.controllers.delete(controller);
    }
  }

  stop(): void {
    for (const controller of this.controllers) controller.abort();
  }
}

/**
 * A TTS that streams one chunk at a time with a delay, so audio is still
 * mid-flight when an interrupt arrives.
 */
export class SlowTTS implements TTS {
  readonly requests: TTSRequest[] = [];
  private readonly controllers = new Set<AbortController>();

  constructor(
    private readonly chunksFor: (text: string) => Uint8Array[],
    private readonly delayMs = 20,
  ) {}

  async *stream(request: TTSRequest): AsyncGenerator<Uint8Array> {
    this.requests.push(request);
    const controller = new AbortController();
    this.controllers.add(controller);
    try {
      for (const chunk of this.chunksFor(request.text)) {
        await Bun.sleep(this.delayMs);
        if (controller.signal.aborted) {
          throw new DOMException("The operation was aborted.", "AbortError");
        }
        yield chunk;
      }
    } finally {
      this.controllers.delete(controller);
    }
  }

  stop(): void {
    for (const controller of this.controllers) controller.abort();
  }
}

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

export type TtsHarness = FakeTTS | SlowTTS;

export interface Harness {
  conversation: Conversation;
  orchestrator: Orchestrator;
  llm: FakeLLM;
  stt: FakeSTT;
  tts: TtsHarness;
  persistence: MemoryPersistence;
}

export function setup(options: {
  script: LLMScript;
  ttsChunks?: (text: string) => Uint8Array[];
  tts?: TtsHarness;
  tools?: Tool<never, unknown>[];
  toolTimeoutMs?: number;
  context?: string;
  /** Inject a real LLM (e.g. an adapter over a mocked fetch) instead of a scripted fake. */
  llm?: LLM;
  /** Override the conversation-history window (default 5 turns / 4k chars). */
  historyWindow?: HistoryWindow | false;
}): Promise<Harness> {
  return (async () => {
    const persistence = new MemoryPersistence();
    const conversation = new Conversation({ id: "conv-1", persistence });
    const llm = options.llm ?? new FakeLLM(options.script);
    const stt = new FakeSTT();
    const tts =
      options.tts ??
      new FakeTTS(
        options.ttsChunks ?? ((text) => [new TextEncoder().encode(text)]),
      );
    const agent = new Agent({
      name: "Jarvis",
      context: options.context ?? "Be concise.",
      llm,
      tools: options.tools,
    });
    const orchestrator = new Orchestrator({
      conversation,
      agents: [agent],
      llm,
      stt,
      tts,
      persistence,
      toolTimeoutMs: options.toolTimeoutMs ?? 30_000,
      historyWindow: options.historyWindow,
    });

    conversation.start();
    await conversation.participate({ userId: "alice", aliases: ["al"] });
    await orchestrator.start();

    return {
      conversation,
      orchestrator,
      // When a real LLM is injected (the stall-recovery suite) it replaces
      // the fake; that suite never reads `.requests`, so the type stays the
      // fake's for the rest of the file.
      llm: llm as FakeLLM,
      stt,
      tts,
      persistence,
    };
  })();
}

export async function waitFor(condition: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (!condition()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error("waitFor timed out");
    }
    await Bun.sleep(2);
  }
}

export async function speak(harness: Harness, userId: string, text: string): Promise<void> {
  harness.conversation.listen({ userId, audio: new Uint8Array([1]) });
  harness.stt.sessions.at(-1)!.emitFinal(text);
  await harness.orchestrator.whenIdle();
}

export function respond(text: string): LLMScript {
  return async function* () {
    yield { type: "delta", content: text };
    yield { type: "done" };
  };
}

// ---------------------------------------------------------------------------
// Multi-agent roster harness (coordinator + named specialists)
// ---------------------------------------------------------------------------

export type RosterHarness = Harness & { llms: Map<string, FakeLLM> };

export function setupRoster(options: {
  coordinatorScript: LLMScript;
  scripts: Record<string, LLMScript>;
  tools?: Record<string, Tool<never, unknown>[]>;
  coordinations?: Record<string, { prompt: string; llm: FakeLLM }>;
  maxCoordinationSteps?: number;
}): Promise<RosterHarness> {
  return (async () => {
    const persistence = new MemoryPersistence();
    const conversation = new Conversation({ id: "conv-1", persistence });
    const stt = new FakeSTT();
    const tts = new FakeTTS((text) => [new TextEncoder().encode(text)]);

    const coordinatorLlm = new FakeLLM(options.coordinatorScript);
    const llms = new Map<string, FakeLLM>([["Jarvis", coordinatorLlm]]);
    const agents: Agent[] = [
      new Agent({ name: "Jarvis", context: "Be concise.", llm: coordinatorLlm }),
    ];
    for (const [name, script] of Object.entries(options.scripts)) {
      const llm = new FakeLLM(script);
      llms.set(name, llm);
      agents.push(
        new Agent({
          name,
          context: `You are ${name}.`,
          llm,
          tools: options.tools?.[name],
        }),
      );
    }
    // The built-in `understand` coordination only activates with a roster of
    // more than one agent, so guarantee one for tests that only exercise the
    // coordination itself.
    if (agents.length === 1) {
      const helperLlm = new FakeLLM(respond("ok"));
      llms.set("Helper", helperLlm);
      agents.push(new Agent({ name: "Helper", context: "You help.", llm: helperLlm }));
    }
    for (const [name, coordination] of Object.entries(options.coordinations ?? {})) {
      llms.set(name, coordination.llm);
    }

    const orchestrator = new Orchestrator({
      conversation,
      agents,
      llm: coordinatorLlm,
      coordinations: options.coordinations,
      maxCoordinationSteps: options.maxCoordinationSteps,
      stt,
      tts,
      persistence,
    });

    conversation.start();
    await conversation.participate({ userId: "alice", aliases: ["al"] });
    await orchestrator.start();

    return { conversation, orchestrator, llm: coordinatorLlm, stt, tts, persistence, llms };
  })();
}
