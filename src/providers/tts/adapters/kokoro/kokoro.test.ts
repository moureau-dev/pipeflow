import { describe, expect, test } from "bun:test";
import { KokoroTTS } from "./kokoro.ts";

function audioResponse(payload: Uint8Array, chunkSizes: number[]): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let offset = 0;
      for (const size of chunkSizes) {
        controller.enqueue(payload.slice(offset, offset + size));
        offset += size;
      }
      controller.close();
    },
  });
  return new Response(stream, {
    status: 200,
    headers: { "content-type": "audio/wav" },
  });
}

async function collect(llm: KokoroTTS, request: Parameters<KokoroTTS["stream"]>[0]): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of llm.stream(request)) {
    chunks.push(chunk);
  }
  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

describe("KokoroTTS", () => {
  test("streams the synthesized audio as chunks", async () => {
    const payload = new TextEncoder().encode("fake-wav-bytes"); // 14 bytes
    const tts = new KokoroTTS({
      chunkSize: 4,
      fetch: async () => audioResponse(payload, [6, 9]),
    });

    const chunks: Uint8Array[] = [];
    for await (const chunk of tts.stream({ text: "hello" })) {
      chunks.push(chunk);
    }

    // 14 payload bytes at chunkSize 4 → 4 chunks, each <= 4 bytes.
    expect(chunks.map((c) => c.length)).toEqual([4, 4, 4, 2]);
    const assembled = await collect(tts, { text: "hello" });
    expect(assembled).toEqual(payload);
  });

  test("yields a single chunk when the payload fits", async () => {
    const payload = new Uint8Array([1, 2, 3]);
    const tts = new KokoroTTS({
      chunkSize: 8192,
      fetch: async () => audioResponse(payload, [3]),
    });

    const chunks: Uint8Array[] = [];
    for await (const chunk of tts.stream({ text: "hi" })) {
      chunks.push(chunk);
    }
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toEqual(payload);
  });

  test("preserves chunk order across network chunk boundaries", async () => {
    const payload = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    const tts = new KokoroTTS({
      chunkSize: 3,
      fetch: async () => audioResponse(payload, [4, 3, 3]),
    });

    const assembled = await collect(tts, { text: "order" });
    expect([...assembled]).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  });

  test("posts the text, voice and model to the speech endpoint", async () => {
    let capturedUrl = "";
    let capturedInit: RequestInit | undefined;
    const tts = new KokoroTTS({
      baseUrl: "http://localhost:9999/",
      voice: "af_bella",
      fetch: async (url, init) => {
        capturedUrl = String(url);
        capturedInit = init;
        return audioResponse(new Uint8Array([1]), [1]);
      },
    });

    await collect(tts, { text: "hello", voice: "am_michael", speed: 1.2 });

    expect(capturedUrl).toBe("http://localhost:9999/v1/audio/speech");
    const body = JSON.parse(String(capturedInit?.body));
    expect(body.model).toBe("kokoro");
    expect(body.input).toBe("hello");
    expect(body.voice).toBe("am_michael");
    expect(body.speed).toBe(1.2);
  });

  test("falls back to the configured voice when the request has none", async () => {
    let capturedInit: RequestInit | undefined;
    const tts = new KokoroTTS({
      voice: "af_heart",
      fetch: async (_url, init) => {
        capturedInit = init;
        return audioResponse(new Uint8Array([1]), [1]);
      },
    });

    await collect(tts, { text: "hello" });
    expect(JSON.parse(String(capturedInit?.body)).voice).toBe("af_heart");
  });

  test("sends the bearer token when configured", async () => {
    let capturedInit: RequestInit | undefined;
    const tts = new KokoroTTS({
      apiKey: "kokoro-key",
      fetch: async (_url, init) => {
        capturedInit = init;
        return audioResponse(new Uint8Array([1]), [1]);
      },
    });

    await collect(tts, { text: "hello" });
    const headers = capturedInit?.headers as Record<string, string>;
    expect(headers.authorization).toBe("Bearer kokoro-key");
  });

  test("rejects empty text", async () => {
    const tts = new KokoroTTS({ fetch: async () => audioResponse(new Uint8Array(), []) });
    await expect(collect(tts, { text: "" })).rejects.toThrow(/text/);
  });

  test("throws on non-ok responses", async () => {
    const tts = new KokoroTTS({
      fetch: async () => new Response("model missing", { status: 400 }),
    });
    await expect(collect(tts, { text: "hello" })).rejects.toThrow(
      /Kokoro request failed \(400\)/,
    );
  });

  test("stop aborts an in-flight synthesis", async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([1, 2, 3]));
        // Never closes.
      },
    });
    const tts = new KokoroTTS({
      chunkSize: 2,
      fetch: async () => new Response(stream, { status: 200 }),
    });

    const generator = tts.stream({ text: "never ends" });
    const first = await generator.next();
    expect(first.value).toEqual(new Uint8Array([1, 2]));

    tts.stop();
    await expect(generator.next()).rejects.toThrow("aborted");
  });

  test("stop is a no-op when nothing is synthesizing", () => {
    const tts = new KokoroTTS();
    expect(() => tts.stop()).not.toThrow();
  });

  test("yields nothing for an empty audio body", async () => {
    const tts = new KokoroTTS({
      fetch: async () => audioResponse(new Uint8Array(), []),
    });
    const chunks: Uint8Array[] = [];
    for await (const chunk of tts.stream({ text: "hi" })) {
      chunks.push(chunk);
    }
    expect(chunks).toEqual([]);
  });
});
