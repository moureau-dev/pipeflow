/**
 * Streaming text segmenter for speech.
 *
 * Turns an incremental LLM token stream into speakable chunks with a boundary
 * hierarchy, so TTS never waits indefinitely for punctuation:
 *
 * 1. **Strong boundary** — `. ! ? \n` flush immediately (sentence end).
 * 2. **Soft boundary** — once the buffer is long enough, split at the last
 *    `, ; :` that yields a chunk of at least `minSoftLength` characters.
 * 3. **Hard cap** — at `maxLength` the buffer flushes regardless of
 *    punctuation.
 *
 * The heuristics are intentionally internal and benchmark-driven rather than
 * configurable through the public API.
 */

const STRONG_BOUNDARIES = new Set([".", "!", "?", "\n"]);
const SOFT_BOUNDARIES = new Set([",", ";", ":"]);

export interface TextChunkerOptions {
  /** Buffer length at which a soft boundary becomes eligible. Default 80. */
  targetLength?: number;
  /** Hard cap before an unconditional flush. Default 140. */
  maxLength?: number;
  /** Smallest chunk a soft boundary may produce. Default 40. */
  minSoftLength?: number;
}

export class TextChunker {
  private readonly targetLength: number;
  private readonly maxLength: number;
  private readonly minSoftLength: number;
  private buffer = "";

  constructor(options: TextChunkerOptions = {}) {
    this.targetLength = options.targetLength ?? 80;
    this.maxLength = options.maxLength ?? 140;
    this.minSoftLength = options.minSoftLength ?? 40;
  }

  /** Feed tokens; returns zero or more complete chunks to synthesize. */
  push(delta: string): string[] {
    this.buffer += delta;
    const chunks: string[] = [];
    for (;;) {
      const chunk = this.takeNext();
      if (chunk === null) break;
      if (chunk.length > 0) chunks.push(chunk);
    }
    return chunks;
  }

  /** Flush any remaining buffered text as a final chunk (or null). */
  flush(): string | null {
    const rest = this.buffer.trim();
    this.buffer = "";
    return rest.length > 0 ? rest : null;
  }

  /** Drop the buffer (interrupt, stop). */
  clear(): void {
    this.buffer = "";
  }

  private takeNext(): string | null {
    if (this.buffer.length === 0) return null;

    // 1. Strong boundary — flush at the first sentence end for low latency.
    for (let i = 0; i < this.buffer.length; i++) {
      if (STRONG_BOUNDARIES.has(this.buffer[i]!)) return this.takeThrough(i);
    }

    // 2. Soft boundary once the buffer is long enough: prefer the last
    //    comma/semicolon/colon, as long as it yields a chunk of at least
    //    minSoftLength (never split a short clause off early).
    if (this.buffer.length >= this.targetLength) {
      for (let i = this.buffer.length - 1; i >= 0; i--) {
        if (SOFT_BOUNDARIES.has(this.buffer[i]!)) {
          if (i + 1 >= this.minSoftLength) return this.takeThrough(i);
          break; // any earlier boundary is even smaller
        }
      }
    }

    // 3. Hard cap — never wait indefinitely for punctuation.
    if (this.buffer.length >= this.maxLength) {
      return this.takeThrough(this.maxLength - 1);
    }

    return null;
  }

  /** Cut the buffer through index `i` (inclusive) and return the text. */
  private takeThrough(i: number): string {
    const chunk = this.buffer.slice(0, i + 1).trim();
    this.buffer = this.buffer.slice(i + 1);
    return chunk;
  }
}
