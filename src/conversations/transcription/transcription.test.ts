import { describe, expect, test } from "bun:test";
import { Transcription, TranscriptEntry } from "./transcription.ts";

describe("Transcription", () => {
  test("starts empty", () => {
    const transcription = new Transcription("conv-1");
    expect(transcription.isEmpty).toBe(true);
    expect(transcription.length).toBe(0);
    expect(transcription.list()).toEqual([]);
    expect(transcription.last()).toBeNull();
  });

  test("appendSpeech creates participant entries in order", () => {
    const transcription = new Transcription("conv-1");
    const first = transcription.appendSpeech("alice", "Hello there.");
    const second = transcription.appendSpeech("bob", "Hi alice!");

    expect(first.speaker).toBe("alice");
    expect(first.speakerKind).toBe("participant");
    expect(first.conversationId).toBe("conv-1");
    expect(first.sequence).toBe(0);
    expect(second.sequence).toBe(1);
    expect(second.speaker).toBe("bob");
  });

  test("appendGeneration creates agent entries", () => {
    const transcription = new Transcription("conv-1");
    const entry = transcription.appendGeneration("Jarvis", "How can I help?");

    expect(entry.speakerKind).toBe("agent");
    expect(entry.speaker).toBe("Jarvis");
    expect(entry.sequence).toBe(0);
  });

  test("entries receive unique ids and a shared conversation id", () => {
    const transcription = new Transcription("conv-1");
    const a = transcription.appendSpeech("alice", "one");
    const b = transcription.appendSpeech("bob", "two");
    expect(a.id).not.toBe(b.id);
    expect(a.conversationId).toBe("conv-1");
    expect(b.conversationId).toBe("conv-1");
  });

  test("explicit timestamps are honored", () => {
    const transcription = new Transcription("conv-1");
    const entry = transcription.appendSpeech("alice", "hi", 123456);
    expect(entry.timestamp).toBe(123456);
  });

  test("list returns entries in insertion order", () => {
    const transcription = new Transcription("conv-1");
    transcription.appendSpeech("alice", "one");
    transcription.appendGeneration("Jarvis", "two");
    transcription.appendSpeech("bob", "three");

    expect(transcription.list().map((e) => e.text)).toEqual(["one", "two", "three"]);
    expect(transcription.length).toBe(3);
    expect(transcription.isEmpty).toBe(false);
  });

  test("lookup by id and by sequence", () => {
    const transcription = new Transcription("conv-1");
    const entry = transcription.appendSpeech("alice", "hi");

    expect(transcription.get(entry.id)).toBe(entry);
    expect(transcription.get("missing")).toBeNull();
    expect(transcription.getBySequence(0)).toBe(entry);
    expect(transcription.getBySequence(99)).toBeNull();
  });

  test("last returns the most recent entry", () => {
    const transcription = new Transcription("conv-1");
    transcription.appendSpeech("alice", "one");
    const last = transcription.appendGeneration("Jarvis", "two");
    expect(transcription.last()).toBe(last);
  });

  test("rejects duplicate ids", () => {
    const transcription = new Transcription("conv-1");
    const entry = transcription.appendSpeech("alice", "hi");
    expect(() =>
      transcription.append({ ...entry, id: entry.id, text: "again" }),
    ).toThrow(/already exists/);
  });

  test("clear resets all state", () => {
    const transcription = new Transcription("conv-1");
    transcription.appendSpeech("alice", "one");
    transcription.appendSpeech("bob", "two");
    transcription.clear();

    expect(transcription.isEmpty).toBe(true);
    expect(transcription.length).toBe(0);
    expect(transcription.list()).toEqual([]);
    expect(transcription.last()).toBeNull();

    // Sequence numbers restart after clear.
    const entry = transcription.appendSpeech("alice", "fresh");
    expect(entry.sequence).toBe(0);
  });

  test("toString renders speaker and text", () => {
    const transcription = new Transcription("conv-1");
    const entry = transcription.appendSpeech("alice", "Hello world");
    expect(entry.toString()).toBe("alice: Hello world");
  });

  test("fromPlain rebuilds an entry with the same shape", () => {
    const transcription = new Transcription("conv-1");
    const original = transcription.appendSpeech("alice", "hi");

    // Persisted entries travel as plain data; `fromPlain` rehydrates them
    // into a full TranscriptEntry (including `toString`).
    const plain = { ...original };
    const rebuilt = TranscriptEntry.fromPlain(plain);

    expect(rebuilt.id).toBe(original.id);
    expect(rebuilt.speaker).toBe("alice");
    expect(rebuilt.text).toBe("hi");
    expect(rebuilt.sequence).toBe(0);
    expect(rebuilt.toString()).toBe("alice: hi");
    expect(rebuilt).not.toBe(original);
  });
});
