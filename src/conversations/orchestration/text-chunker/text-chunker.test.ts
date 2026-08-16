import { describe, expect, test } from "bun:test";
import { TextChunker } from "./text-chunker";

describe("TextChunker", () => {
  test("flushes immediately at a strong sentence boundary", () => {
    const chunker = new TextChunker();
    expect(chunker.push("Hello there!")).toEqual(["Hello there!"]);
    expect(chunker.push("How are you?")).toEqual(["How are you?"]);
    expect(chunker.push("Fine.")).toEqual(["Fine."]);
  });

  test("flushes multiple strong boundaries from one delta", () => {
    const chunker = new TextChunker();
    expect(chunker.push("One. Two! Three?\nFour.")).toEqual([
      "One.",
      "Two!",
      "Three?",
      "Four.",
    ]);
  });

  test("keeps partial sentences buffered across deltas", () => {
    const chunker = new TextChunker();
    expect(chunker.push("It is ")).toEqual([]);
    expect(chunker.push("sunny in ")).toEqual([]);
    expect(chunker.push("Paris.")).toEqual(["It is sunny in Paris."]);
  });

  test("splits at a soft boundary once the buffer is long enough", () => {
    // targetLength 80, minSoftLength 40. The comma sits past the minimum, so
    // the clause flushes instead of waiting for the final period.
    const chunker = new TextChunker({ targetLength: 80, maxLength: 200 });
    expect(chunker.push("a".repeat(70) + "," + "b".repeat(10))).toEqual([
      "a".repeat(70) + ",",
    ]);
    expect(chunker.push(" still buffered.")).toEqual(["b".repeat(10) + " still buffered."]);
  });

  test("never splits a short clause off early at a soft boundary", () => {
    // The only comma sits at 5 < minSoftLength, so it is ignored and the
    // buffer keeps growing until flushed.
    const chunker = new TextChunker({ targetLength: 80, maxLength: 200 });
    expect(chunker.push("Hello,")).toEqual([]);
    expect(chunker.push(" " + "b".repeat(100))).toEqual([]);
    expect(chunker.flush()).toBe("Hello, " + "b".repeat(100));
  });

  test("hard-flushes at maxLength without waiting for punctuation", () => {
    const chunker = new TextChunker({ maxLength: 20 });
    const chunks = chunker.push("a".repeat(45));
    expect(chunks).toEqual(["a".repeat(20), "a".repeat(20)]);
    expect(chunker.flush()).toBe("a".repeat(5));
  });

  test("prefers a soft boundary over the hard cap when one exists", () => {
    const chunker = new TextChunker({ targetLength: 80, minSoftLength: 40, maxLength: 140 });
    // A long run with a late comma splits there rather than at the cap; the
    // remainder stays buffered until the next flush.
    const text = "x".repeat(90) + ", " + "y".repeat(50);
    expect(chunker.push(text)).toEqual(["x".repeat(90) + ","]);
    expect(chunker.flush()).toBe("y".repeat(50));
  });

  test("flush returns the remaining buffered text", () => {
    const chunker = new TextChunker();
    expect(chunker.push("no punctuation yet")).toEqual([]);
    expect(chunker.flush()).toBe("no punctuation yet");
    expect(chunker.flush()).toBeNull();
  });

  test("never loses text across many small deltas", () => {
    const chunker = new TextChunker();
    const words = [
      "The ",
      "dragon ",
      "flew, ",
      "and ",
      "the ",
      "knight ",
      "watched ",
      "from ",
      "the ",
      "castle, ",
      "wondering ",
      "what ",
      "would ",
      "happen ",
      "next.",
    ];
    const emitted: string[] = [];
    for (const word of words) emitted.push(...chunker.push(word));
    const rest = chunker.flush();
    if (rest) emitted.push(rest);

    const joined = emitted.join(" ");
    for (const word of words) {
      expect(joined).toContain(word.trim());
    }
  });

  test("clear drops the buffer", () => {
    const chunker = new TextChunker();
    chunker.push("half a sentence");
    chunker.clear();
    expect(chunker.flush()).toBeNull();
  });
});
