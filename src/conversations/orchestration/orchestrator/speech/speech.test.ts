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

    // A complete sentence queues a synthesis request; stop() bumps the speech
    // epoch before the chain runs, so the request never fires.
    pipeline.feed("Hello world!", 0);
    pipeline.stop();
    await pipeline.waitForIdle();
    expect(tts.requests).toHaveLength(0);
    expect(audio).toHaveLength(0);

    // A partial sentence is discarded from the chunker too.
    pipeline.feed("More words", 0);
    pipeline.stop();
    await pipeline.waitForIdle();
    expect(tts.requests).toHaveLength(0);
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
    expect(tts.requests).toHaveLength(0);
    expect(audio).toHaveLength(0);
  });
});
