import type { Conversation } from "../../../conversation/conversation";
import type { TTS } from "../../../../providers/tts/types";
import { TextChunker } from "../../text-chunker/text-chunker";

export interface SpeechPipelineOptions {
  /** TTS provider; omitted for text-only conversations. */
  tts?: TTS;
  conversation: Conversation;
  /**
   * True while the generation that produced the speech is still current.
   * The captured generation epoch is passed back in, so an interrupt (epoch
   * bump) or a stop drops queued and in-flight synthesis.
   */
  isCurrent(epoch: number): boolean;
  /**
   * How many synthesis requests may be in flight at once. Sentences are
   * started as soon as a slot is free — the next one synthesizes while the
   * current one is still streaming — so playback never waits for the whole
   * reply, but a burst of many sentences can't flood the provider (free TTS
   * variants rate-limit concurrent requests). Default 2.
   */
  maxConcurrentRequests?: number;
}

/**
 * Turns the LLM delta stream into speakable audio: expose the text stream
 * semantically (`text-delta`), buffer sentences through the `TextChunker`,
 * and synthesize each chunk through the TTS provider on a serial chain.
 *
 * Owns the chunker, the speech epoch (bumped by `stop()`), the synthesis
 * chain, and the audio sequence — the orchestrator only decides *when*
 * speech is current.
 */
export class SpeechPipeline {
  private readonly tts: TTS | undefined;
  private readonly conversation: Conversation;
  private readonly isCurrent: (epoch: number) => boolean;
  private readonly maxConcurrent: number;
  private readonly chunker = new TextChunker();
  private speechEpoch = 0;
  private chain: Promise<void> = Promise.resolve();
  private audioSequence = 0;
  /** Flushed sentences still waiting for a synthesis slot. */
  private readonly queue: {
    sentence: string;
    epoch: number;
    speechEpoch: number;
  }[] = [];
  /** Synthesis requests started but not yet fully delivered. */
  private inFlight = 0;

  constructor(options: SpeechPipelineOptions) {
    this.tts = options.tts;
    this.conversation = options.conversation;
    this.isCurrent = options.isCurrent;
    this.maxConcurrent = Math.max(1, options.maxConcurrentRequests ?? 2);
  }

  /**
   * Stream an LLM delta to the application and the TTS pipeline. Empty
   * deltas (reasoning-only frames) are skipped so they never reach the
   * text-delta event or the chunker.
   */
  feed(delta: string, epoch: number): void {
    if (delta.length === 0) return;
    // First-token latency for the in-flight generation.
    this.conversation.noteTiming("firstToken");
    // Expose the text stream semantically: applications can render or act on
    // partial replies without waiting for the generation to complete.
    this.conversation.pushTextDelta(delta);
    // The chunker turns the token stream into speakable chunks: strong
    // sentence boundaries flush immediately, long clauses flush at soft
    // boundaries, and nothing waits indefinitely for punctuation.
    for (const chunk of this.chunker.push(delta)) {
      this.speak(chunk, epoch);
    }
  }

  /** Speak any remaining buffered text as a final chunk. */
  flush(epoch: number): void {
    const rest = this.chunker.flush();
    if (rest) this.speak(rest, epoch);
  }

  /**
   * Queue a sentence for synthesis, starting it if a slot is free. The text
   * order is preserved end to end: requests start in flush order, and delivery
   * below is serialized through `chain`, so sentence N never overtakes N-1.
   */
  speak(sentence: string, epoch: number): void {
    const tts = this.tts;
    if (!tts) return;
    // Buffering boundary: the first sentence flushed to TTS.
    this.conversation.noteTiming("firstTtsText");
    const speechEpoch = this.speechEpoch;
    this.queue.push({ sentence, epoch, speechEpoch });
    this.startNext();
  }

  /**
   * Start synthesis for queued sentences up to the concurrency bound. A
   * sentence's request is fired as soon as a slot is free — while the previous
   * sentence is still streaming/playing — so the first piece is ready first
   * and later pieces overlap it, without ever flooding the provider with one
   * request per sentence of a long reply.
   */
  private startNext(): void {
    const tts = this.tts;
    while (tts && this.inFlight < this.maxConcurrent && this.queue.length > 0) {
      const { sentence, epoch, speechEpoch } = this.queue.shift()!;
      this.inFlight++;
      // Begin synthesis immediately — the provider request overlaps the
      // previous sentence's playback. Consuming the first chunk eagerly is
      // what starts the request; delivery still happens in order through the
      // serial chain below.
      const stream = tts.stream({ text: sentence });
      const firstChunk = stream.next();
      void firstChunk.catch(() => {});
      this.chain = this.chain.then(async () => {
        try {
          if (!this.isCurrent(epoch) || this.speechEpoch !== speechEpoch) return;
          // The TTS provider was asked to synthesize.
          this.conversation.noteTiming("firstTtsRequest");
          let first = true;
          const head = await firstChunk;
          if (!head.done) {
            first = false;
            // The provider produced its first audio chunk.
            this.conversation.noteTiming("firstTtsAudio");
            this.conversation.pushAudio({
              data: head.value,
              timestamp: Date.now(),
              sequence: this.audioSequence++,
            });
          }
          // The generator's async iterator is the generator itself, so this
          // continues from where the eager `next()` left off.
          for await (const chunk of stream) {
            if (!this.isCurrent(epoch) || this.speechEpoch !== speechEpoch) {
              break;
            }
            if (first) {
              first = false;
              // The provider produced its first audio chunk.
              this.conversation.noteTiming("firstTtsAudio");
            }
            this.conversation.pushAudio({
              data: chunk,
              timestamp: Date.now(),
              sequence: this.audioSequence++,
            });
          }
        } catch (error) {
          // A stop (speech epoch bump) or an interrupt (generation epoch bump)
          // aborts the stream — that's not a provider failure. Anything else
          // reaches the application as an error.
          if (!this.isCurrent(epoch) || this.speechEpoch !== speechEpoch) return;
          this.conversation.emit("error", {
            conversationId: this.conversation.id,
            error: error instanceof Error ? error : new Error(String(error)),
          });
        } finally {
          // The request is fully read and delivered: free the slot for the
          // next queued sentence.
          this.inFlight--;
          this.startNext();
        }
      });
    }
  }

  /**
   * Stop the current TTS playback and drop buffered text without cancelling
   * the generation (barge-in, interrupt, stop).
   */
  stop(): void {
    this.speechEpoch++;
    this.chunker.clear();
    this.queue.length = 0;
    this.tts?.stop();
  }

  /**
   * Resolve when every queued and in-flight sentence has been synthesized and
   * delivered. Unlike the delivery chain alone, this also waits for sentences
   * still waiting on a synthesis slot.
   */
  async waitForIdle(): Promise<void> {
    for (;;) {
      if (this.queue.length === 0 && this.inFlight === 0) return;
      await this.chain;
    }
  }
}
