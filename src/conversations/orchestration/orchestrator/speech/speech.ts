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
  private readonly chunker = new TextChunker();
  private speechEpoch = 0;
  private chain: Promise<void> = Promise.resolve();
  private audioSequence = 0;

  constructor(options: SpeechPipelineOptions) {
    this.tts = options.tts;
    this.conversation = options.conversation;
    this.isCurrent = options.isCurrent;
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

  /** Synthesize a sentence and push the audio chunks out to the app. */
  speak(sentence: string, epoch: number): void {
    const tts = this.tts;
    if (!tts) return;
    // Buffering boundary: the first sentence flushed to TTS.
    this.conversation.noteTiming("firstTtsText");
    const speechEpoch = this.speechEpoch;
    this.chain = this.chain.then(async () => {
      if (!this.isCurrent(epoch) || this.speechEpoch !== speechEpoch) {
        return;
      }
      // The TTS provider was asked to synthesize.
      this.conversation.noteTiming("firstTtsRequest");
      try {
        let first = true;
        for await (const chunk of tts.stream({ text: sentence })) {
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
        if (!this.isCurrent(epoch)) return; // interrupted
        this.conversation.emit("error", {
          conversationId: this.conversation.id,
          error: error instanceof Error ? error : new Error(String(error)),
        });
      }
    });
  }

  /**
   * Stop the current TTS playback and drop buffered text without cancelling
   * the generation (barge-in, interrupt, stop).
   */
  stop(): void {
    this.speechEpoch++;
    this.chunker.clear();
    this.tts?.stop();
  }

  /** Resolve when queued TTS synthesis has settled. */
  waitForIdle(): Promise<void> {
    return this.chain;
  }
}
