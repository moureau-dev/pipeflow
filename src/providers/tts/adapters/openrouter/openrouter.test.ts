import { describe, expect, test } from "bun:test";
import { OpenRouterTTS } from "./openrouter";
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

async function collect(tts: OpenRouterTTS, text: string): Promise<Uint8Array[]> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of tts.stream({ text })) chunks.push(chunk);
  return chunks;
}

describe("OpenRouterTTS", () => {
  test("posts the request and yields the audio re-chunked", async () => {
    const audio = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    const { calls, fetch } = makeFakeFetch(async () => new Response(audio, { status: 200 }));
    const tts = new OpenRouterTTS({ apiKey: "test-key", chunkSize: 4, fetch });

    const chunks = await collect(tts, "Hello world");
    expect(chunks.map((c) => [...c])).toEqual([
      [1, 2, 3, 4],
      [5, 6, 7, 8],
      [9, 10],
    ]);

    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toContain("/audio/speech");
    const body = JSON.parse(calls[0]!.init.body as string) as Record<string, unknown>;
    expect(body).toMatchObject({
      model: "fish-audio/s2.1-pro-free:free",
      input: "Hello world",
      response_format: "pcm",
    });
    // Voice is omitted unless configured — the default fish model rejects it.
    expect(body.voice).toBeUndefined();
    const headers = new Headers(calls[0]!.init.headers);
    expect(headers.get("authorization")).toBe("Bearer test-key");
    expect(headers.get("content-type")).toContain("application/json");
  });

  test("request voice, speed, and format pass through", async () => {
    const { calls, fetch } = makeFakeFetch(async () => new Response(new Uint8Array(), { status: 200 }));
    const tts = new OpenRouterTTS({ apiKey: "test-key", fetch });

    await collect(tts, "hi");
    await collect(tts, "hi again");
    let body = JSON.parse(calls[0]!.init.body as string) as Record<string, unknown>;
    expect(body.voice).toBeUndefined();
    expect(body.response_format).toBe("pcm");
    expect(body.speed).toBeUndefined();

    body = JSON.parse(calls[1]!.init.body as string) as Record<string, unknown>;
    expect(body.voice).toBeUndefined();

    // A request with explicit voice/speed/format overrides.
    const tts2 = new OpenRouterTTS({ apiKey: "test-key", voice: "alex", fetch });
    const chunks: Uint8Array[] = [];
    for await (const chunk of tts2.stream({ text: "hey", speed: 1.2, format: "mp3" })) {
      chunks.push(chunk);
    }
    body = JSON.parse(calls[2]!.init.body as string) as Record<string, unknown>;
    expect(body.voice).toBe("alex");
    expect(body.speed).toBe(1.2);
    expect(body.response_format).toBe("mp3");
  });

  test("custom model and base URL are honored", async () => {
    const { calls, fetch } = makeFakeFetch(async () => new Response(new Uint8Array(), { status: 200 }));
    const tts = new OpenRouterTTS({
      apiKey: "test-key",
      model: "fish-audio/s2.1-pro",
      baseUrl: "https://example.com/api/v1/",
      fetch,
    });

    await collect(tts, "hi");
    expect(calls[0]!.url).toBe("https://example.com/api/v1/audio/speech");
    const body = JSON.parse(calls[0]!.init.body as string) as Record<string, unknown>;
    expect(body.model).toBe("fish-audio/s2.1-pro");
  });

  test("a non-200 response throws with the status", async () => {
    const { fetch } = makeFakeFetch(async () =>
      new Response(JSON.stringify({ error: "voice required" }), { status: 400 }),
    );
    const tts = new OpenRouterTTS({ apiKey: "test-key", fetch });

    await expect(collect(tts, "hi")).rejects.toThrow(/400/);
  });

  test("empty text throws", async () => {
    const { fetch } = makeFakeFetch(async () => new Response(new Uint8Array(), { status: 200 }));
    const tts = new OpenRouterTTS({ apiKey: "test-key", fetch });

    await expect(collect(tts, "")).rejects.toThrow(/requires request\.text/);
  });

  test("stop() aborts a stream in progress", async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([1, 2, 3]));
        // Never closes: the reader would hang waiting for more audio.
      },
    });
    const { fetch } = makeFakeFetch(async () => new Response(body, { status: 200 }));
    const tts = new OpenRouterTTS({ apiKey: "test-key", chunkSize: 2, fetch });

    const gen = tts.stream({ text: "hi" });
    const first = await gen.next();
    expect([...(first.value as Uint8Array)]).toEqual([1, 2]);

    tts.stop();
    await expect(gen.next()).rejects.toThrow(/aborted/);
  });
});
