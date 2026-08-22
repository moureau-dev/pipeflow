import { describe, expect, test } from "bun:test";
import { Conversation } from "../../../conversation/conversation";
import { MemoryPersistence } from "../../../../persistence/adapters/memory/memory";
import { SpeechPipeline } from "./speech";
import type { TTS, TTSRequest } from "../../../../providers/tts/types";

class FakeTTS implements TTS {
  readonly requests: TTSRequest[] = [];
  constructor(private readonly chunker: (text: string) => Uint8Array[]) {}
  async *stream(request: TTSRequest): AsyncGenerator<Uint8Array> {
    this.requests.push(request);
    for (const chunk of this.chunker(request.text)) yield chunk;
  }
  stop(): void {}
}

/** A TTS whose `stop()` aborts in-flight synthesis, like the real adapters. */
class AbortableTTS implements TTS {
  readonly requests: TTSRequest[] = [];
  private readonly controllers = new Set<AbortController>();

  async *stream(request: TTSRequest): AsyncGenerator<Uint8Array> {
    this.requests.push(request);
    const controller = new AbortController();
    this.controllers.add(controller);
    try {
      while (true) {
        await Bun.sleep(5);
        if (controller.signal.aborted) {
          throw new DOMException("The operation was aborted.", "AbortError");
        }
        yield encode("chunk ");
      }
    } finally {
      this.controllers.delete(controller);
    }
  }

  stop(): void {
    for (const controller of this.controllers) controller.abort();
  }
}

const encode = (text: string) => new TextEncoder().encode(text);

function makeConversation(): Conversation {
  return new Conversation({ id: "conv-1", persistence: new MemoryPersistence() });
}

describe("SpeechPipeline", () => {
  test("delivers audio chunks to the app in order", async () => {
    const tts = new FakeTTS((text) => [encode(text + " (a)"), encode(text + " (b)")]);
    const conversation = makeConversation();
    const audio: number[] = [];
    conversation.on("audio", (payload) => audio.push(payload.audio.sequence));
    const pipeline = new SpeechPipeline({ tts, conversation, isCurrent: () => true });

    pipeline.feed("Hello world!", 0);
    await pipeline.waitForIdle();
    expect(audio).toEqual([0, 1]);
  });

  test("feed buffers strong sentence boundaries into separate TTS requests", async () => {
    const tts = new FakeTTS((text) => [encode(text)]);
    const conversation = makeConversation();
    const pipeline = new SpeechPipeline({ tts, conversation, isCurrent: () => true });

    pipeline.feed("It is sunny. Very sunny indeed!", 0);
    await pipeline.waitForIdle();
    expect(tts.requests.map((r) => r.text)).toEqual([
      "It is sunny.",
      "Very sunny indeed!",
    ]);
  });

  test("flush speaks the remaining buffered text", async () => {
    const tts = new FakeTTS((text) => [encode(text)]);
    const conversation = makeConversation();
    const pipeline = new SpeechPipeline({ tts, conversation, isCurrent: () => true });

    pipeline.feed("Hello there", 0);
    expect(tts.requests).toHaveLength(0);
    pipeline.flush(0);
    await pipeline.waitForIdle();
    expect(tts.requests.map((r) => r.text)).toEqual(["Hello there"]);
  });

  test("empty deltas never reach the text-delta event or TTS", async () => {
    const tts = new FakeTTS((text) => [encode(text)]);
    const conversation = makeConversation();
    const deltas: string[] = [];
    conversation.on("text-delta", ({ text }) => deltas.push(text));
    const pipeline = new SpeechPipeline({ tts, conversation, isCurrent: () => true });

    pipeline.feed("", 0);
    expect(deltas).toHaveLength(0);
    expect(tts.requests).toHaveLength(0);
  });

  test("stop() drops buffered and queued speech", async () => {
    const tts = new FakeTTS((text) => [encode(text)]);
    const conversation = makeConversation();
    const audio: number[] = [];
    conversation.on("audio", (payload) => audio.push(payload.audio.sequence));
    const pipeline = new SpeechPipeline({ tts, conversation, isCurrent: () => true });

    // A complete sentence pre-starts its synthesis request immediately, but
    // stop() bumps the speech epoch before the chain delivers, so the audio
    // never reaches the app.
    pipeline.feed("Hello world!", 0);
    pipeline.stop();
    await pipeline.waitForIdle();
    expect(tts.requests).toHaveLength(1); // pre-started, then dropped
    expect(audio).toHaveLength(0);

    // A partial sentence is discarded from the chunker before it is spoken.
    pipeline.feed("More words", 0);
    pipeline.stop();
    await pipeline.waitForIdle();
    expect(tts.requests).toHaveLength(1);
    expect(audio).toHaveLength(0);
  });

  test("a stale generation drops its speech", async () => {
    const tts = new FakeTTS((text) => [encode(text)]);
    const conversation = makeConversation();
    const audio: number[] = [];
    conversation.on("audio", (payload) => audio.push(payload.audio.sequence));
    let current = true;
    const pipeline = new SpeechPipeline({ tts, conversation, isCurrent: () => current });

    pipeline.feed("Hello world!", 1);
    current = false; // interrupt: epoch bumped
    await pipeline.waitForIdle();
    expect(tts.requests).toHaveLength(1); // pre-started, then dropped
    expect(audio).toHaveLength(0);
  });

  test("pre-starts the next sentence while the current one is still streaming", async () => {
    const tts = new FakeTTS((text) => [encode(text + " (a)"), encode(text + " (b)")]);
    const conversation = makeConversation();
    const audio: number[] = [];
    conversation.on("audio", (payload) => audio.push(payload.audio.sequence));
    const pipeline = new SpeechPipeline({ tts, conversation, isCurrent: () => true });

    // Both sentences are spoken before the chain delivers either one.
    pipeline.feed("First sentence!", 0);
    pipeline.feed("Second sentence!", 0);

    // Pre-start: both synthesis requests are already in flight, rather than
    // the second waiting for the first to finish synthesizing.
    expect(tts.requests.map((r) => r.text)).toEqual([
      "First sentence!",
      "Second sentence!",
    ]);

    await pipeline.waitForIdle();
    // Delivery remains strictly in order: sentence one, then sentence two.
    expect(audio).toEqual([0, 1, 2, 3]);
  });

  test("a speech-only stop does not emit a spurious error", async () => {
    const tts = new AbortableTTS();
    const conversation = makeConversation();
    const errors: Error[] = [];
    conversation.on("error", ({ error }) => errors.push(error));
    // The generation stays current — this is the coordination-question case,
    // where the question's playback is stopped but no interrupt fires.
    const pipeline = new SpeechPipeline({ tts, conversation, isCurrent: () => true });

    pipeline.feed("Any questions?", 0);
    await Bun.sleep(20); // synthesis is streaming
    pipeline.stop(); // speech epoch bumps; the stream aborts and rejects
    await pipeline.waitForIdle();

    expect(errors).toEqual([]);
  });

  test("a genuine TTS failure emits an error event", async () => {
    const tts = new FakeTTS(() => {
      throw new Error("provider down");
    });
    const conversation = makeConversation();
    const errors: Error[] = [];
    conversation.on("error", ({ error }) => errors.push(error));
    const pipeline = new SpeechPipeline({ tts, conversation, isCurrent: () => true });

    pipeline.feed("Hello!", 0);
    await pipeline.waitForIdle();

    expect(errors.map((e) => e.message)).toEqual(["provider down"]);
  });
});
