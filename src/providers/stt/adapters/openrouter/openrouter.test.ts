import { describe, expect, test } from "bun:test";
import { OpenRouterSTT, toWav } from "./openrouter";
import type { FetchLike } from "../../../shared";

/** A fetch double that records requests and lets each test script responses. */
function makeFakeFetch(
  handler: (init: RequestInit, url: string) => Promise<Response>,
): { calls: { url: string; init: RequestInit }[]; fetch: FetchLike } {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetch = async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = typeof input === "string" ? input : String(input);
    calls.push({ url, init });
    return handler(init, url);
  };
  return { calls, fetch };
}

const ok = (text: string) =>
  new Response(JSON.stringify({ text }), { status: 200 });

describe("OpenRouterSTT", () => {
  test("transcribes a clip once silence elapses", async () => {
    const { calls, fetch } = makeFakeFetch(async () => ok("hello world"));
    const stt = new OpenRouterSTT({ apiKey: "test-key", silenceMs: 5, fetch });
    const session = stt.start();
    const finals: string[] = [];
    const errors: Error[] = [];
    session.on("final", (text) => finals.push(text));
    session.on("error", (error) => errors.push(error));

    session.write(new Uint8Array([1, 2, 3, 4]));
    await Bun.sleep(40);

    expect(errors).toEqual([]);
    expect(finals).toEqual(["hello world"]);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toContain("/audio/transcriptions");

    // The clip is sent as a WAV file with the raw PCM payload.
    const form = calls[0]!.init.body as FormData;
    expect(form.get("model")).toBe("openai/whisper-large-v3-turbo");
    const file = form.get("file") as File;
    expect(file.name).toBe("audio.wav");
    expect(file.type).toBe("audio/wav");
    const bytes = new Uint8Array(await file.arrayBuffer());
    expect(new TextDecoder().decode(bytes.subarray(0, 4))).toBe("RIFF");
    expect(new DataView(bytes.buffer).getUint32(24, true)).toBe(16_000);
    expect([...bytes.subarray(44)]).toEqual([1, 2, 3, 4]);
  });

  test("end() transcribes the trailing buffer", async () => {
    const { calls, fetch } = makeFakeFetch(async () => ok("last words"));
    const stt = new OpenRouterSTT({ apiKey: "test-key", fetch });
    const session = stt.start();
    const finals: string[] = [];
    session.on("final", (text) => finals.push(text));

    session.write(new Uint8Array([9, 9, 9]));
    await session.end();

    expect(finals).toEqual(["last words"]);
    expect(calls).toHaveLength(1);
  });

  test("silence-separated clips produce separate finals in order", async () => {
    const texts = ["first", "second"];
    let n = 0;
    const { calls, fetch } = makeFakeFetch(async () => ok(texts[n++]!));
    const stt = new OpenRouterSTT({ apiKey: "test-key", silenceMs: 5, fetch });
    const session = stt.start();
    const finals: string[] = [];
    session.on("final", (text) => finals.push(text));

    session.write(new Uint8Array([1]));
    await Bun.sleep(20);
    session.write(new Uint8Array([2]));
    await Bun.sleep(20);

    expect(finals).toEqual(["first", "second"]);
    expect(calls).toHaveLength(2);
  });

  test("an empty transcription is not emitted", async () => {
    const { fetch } = makeFakeFetch(async () => ok("   "));
    const stt = new OpenRouterSTT({ apiKey: "test-key", silenceMs: 5, fetch });
    const session = stt.start();
    const finals: string[] = [];
    session.on("final", (text) => finals.push(text));

    session.write(new Uint8Array([0, 0]));
    await Bun.sleep(30);

    expect(finals).toEqual([]);
  });

  test("an HTTP error emits an error event", async () => {
    const { fetch } = makeFakeFetch(async () => new Response("boom", { status: 500 }));
    const stt = new OpenRouterSTT({ apiKey: "test-key", silenceMs: 5, fetch });
    const session = stt.start();
    const errors: Error[] = [];
    session.on("error", (error) => errors.push(error));

    session.write(new Uint8Array([1]));
    await Bun.sleep(30);

    expect(errors).toHaveLength(1);
    expect(errors[0]!.message).toContain("500");
  });

  test("cancel() aborts in-flight requests and drops the result", async () => {
    const { fetch } = makeFakeFetch(async (init) => {
      // Hang until the session is cancelled, then respond late.
      await new Promise<void>((resolve) =>
        init.signal?.addEventListener("abort", () => resolve()),
      );
      return ok("late");
    });
    const stt = new OpenRouterSTT({ apiKey: "test-key", silenceMs: 5, fetch });
    const session = stt.start();
    const finals: string[] = [];
    session.on("final", (text) => finals.push(text));

    session.write(new Uint8Array([1]));
    await Bun.sleep(20); // the request is now in flight
    stt.cancel();
    await Bun.sleep(10);

    expect(finals).toEqual([]);
  });

  test("passes the language through to the request", async () => {
    const { calls, fetch } = makeFakeFetch(async () => ok("こんにちは"));
    const stt = new OpenRouterSTT({ apiKey: "test-key", language: "ja", silenceMs: 5, fetch });
    const session = stt.start();
    session.on("final", () => {});

    session.write(new Uint8Array([1]));
    await Bun.sleep(30);

    const form = calls[0]!.init.body as FormData;
    expect(form.get("language")).toBe("ja");
  });

  test("language: 'auto' is omitted (provider-side detection)", async () => {
    const { calls, fetch } = makeFakeFetch(async () => ok("hi"));
    const stt = new OpenRouterSTT({ apiKey: "test-key", language: "auto", silenceMs: 5, fetch });
    const session = stt.start();
    session.on("final", () => {});

    session.write(new Uint8Array([1]));
    await Bun.sleep(30);

    const form = calls[0]!.init.body as FormData;
    expect(form.get("language")).toBeNull();
  });

  test("audioFormat: 'mp3' sends pre-encoded bytes as-is", async () => {
    const { calls, fetch } = makeFakeFetch(async () => ok("hello"));
    const stt = new OpenRouterSTT({ apiKey: "test-key", audioFormat: "mp3", silenceMs: 5, fetch });
    const session = stt.start();
    const finals: string[] = [];
    session.on("final", (text) => finals.push(text));

    const clip = new TextEncoder().encode("ID3not really mp3 bytes");
    session.write(clip);
    await Bun.sleep(30);

    expect(finals).toEqual(["hello"]);
    const file = (calls[0]!.init.body as FormData).get("file") as File;
    expect(file.name).toBe("audio.mp3");
    expect(file.type).toBe("audio/mpeg");
    // No WAV wrapping: the bytes are passed through untouched.
    const bytes = new Uint8Array(await file.arrayBuffer());
    expect([...bytes]).toEqual([...clip]);
  });

  test("write after end throws", async () => {
    const { fetch } = makeFakeFetch(async () => ok("done"));
    const stt = new OpenRouterSTT({ apiKey: "test-key", fetch });
    const session = stt.start();

    await session.end();
    expect(() => session.write(new Uint8Array([1]))).toThrow();
  });

  test("multiple sessions are cancelled together", async () => {
    const { fetch } = makeFakeFetch(async (init) => {
      await new Promise<void>((resolve) =>
        init.signal?.addEventListener("abort", () => resolve()),
      );
      return ok("late");
    });
    const stt = new OpenRouterSTT({ apiKey: "test-key", silenceMs: 5, fetch });
    const one = stt.start();
    const two = stt.start();
    const finals: string[] = [];
    one.on("final", (t) => finals.push(t));
    two.on("final", (t) => finals.push(t));

    one.write(new Uint8Array([1]));
    two.write(new Uint8Array([2]));
    await Bun.sleep(20);
    stt.cancel();
    await Bun.sleep(10);

    expect(finals).toEqual([]);
  });
});

describe("toWav", () => {
  test("builds a valid RIFF/WAVE header around the PCM payload", () => {
    const wav = toWav(new Uint8Array([1, 2]), 16_000);
    expect(wav.byteLength).toBe(46); // 44-byte header + 2 bytes
    const view = new DataView(wav.buffer);
    expect(new TextDecoder().decode(wav.subarray(0, 4))).toBe("RIFF");
    expect(new TextDecoder().decode(wav.subarray(8, 12))).toBe("WAVE");
    expect(new TextDecoder().decode(wav.subarray(12, 16))).toBe("fmt ");
    expect(view.getUint16(20, true)).toBe(1); // PCM
    expect(view.getUint16(22, true)).toBe(1); // mono
    expect(view.getUint32(24, true)).toBe(16_000);
    expect(view.getUint16(34, true)).toBe(16); // bits per sample
    expect(view.getUint32(40, true)).toBe(2); // data size
    expect([...wav.subarray(44)]).toEqual([1, 2]);
  });

  test("matches the session's sample rate", () => {
    const wav = toWav(new Uint8Array(0), 44_100);
    expect(new DataView(wav.buffer).getUint32(24, true)).toBe(44_100);
  });
});
