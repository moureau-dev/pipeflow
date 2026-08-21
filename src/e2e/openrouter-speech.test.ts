// Live OpenRouter speech e2e: the TTS and STT adapters against the real API.
//
//   bun test src/e2e/openrouter-speech.test.ts
//
// Requires OPENROUTER_API_KEY. The round-trip test self-generates its audio
// fixture: fish-audio TTS speaks a known sentence, whisper STT transcribes it,
// and the transcript is checked for the expected words.

import { describe, expect, test } from "bun:test";
import { OpenRouterSTT } from "../providers/stt/adapters/openrouter/openrouter";
import { OpenRouterTTS } from "../providers/tts/adapters/openrouter/openrouter";

const apiKey = process.env.OPENROUTER_API_KEY;
const hasKey = typeof apiKey === "string" && apiKey.length > 0;

function e2e(name: string, fn: () => Promise<void>, timeoutMs = 90_000): void {
  if (hasKey) {
    test(name, fn, timeoutMs);
  } else {
    test.skip(name, fn);
  }
}

const KEY = apiKey as string;
const SENTENCE = "The quick brown fox jumps over the lazy dog.";

async function synthesize(
  tts: OpenRouterTTS,
  text: string,
  format?: "pcm" | "mp3",
): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of tts.stream({ text, format })) {
    chunks.push(chunk);
  }
  let total = 0;
  for (const chunk of chunks) total += chunk.byteLength;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

describe("OpenRouter speech e2e (requires OPENROUTER_API_KEY)", () => {
  e2e("synthesizes real audio with fish-audio/s2.1-pro-free:free", async () => {
    const tts = new OpenRouterTTS({
      apiKey: KEY,
      model: "fish-audio/s2.1-pro-free:free",
    });

    const pcm = await synthesize(tts, SENTENCE, "pcm");
    // A ~2-3s sentence at 44.1 kHz linear16 is tens of KB; this proves the
    // model produced actual audio rather than an error page or silence.
    expect(pcm.byteLength).toBeGreaterThan(5_000);

    const mp3 = await synthesize(tts, SENTENCE, "mp3");
    expect(mp3.byteLength).toBeGreaterThan(1_000);
  });

  e2e("round-trips TTS audio through STT (fish speaks, whisper listens)", async () => {
    const tts = new OpenRouterTTS({
      apiKey: KEY,
      model: "fish-audio/s2.1-pro-free:free",
    });
    const stt = new OpenRouterSTT({
      apiKey: KEY,
      model: "openai/whisper-large-v3-turbo",
      // The synthesized clip is pre-encoded mp3 — self-describing, so no
      // sample-rate assumptions are needed (unlike raw pcm from TTS, whose
      // rate differs from the STT adapter's default 16 kHz).
      audioFormat: "mp3",
      silenceMs: 200,
    });

    const audio = await synthesize(tts, SENTENCE, "mp3");
    expect(audio.byteLength).toBeGreaterThan(1_000);

    const session = stt.start();
    const finals: string[] = [];
    const errors: Error[] = [];
    session.on("final", (text) => finals.push(text));
    session.on("error", (error) => errors.push(error));

    session.write(audio);
    await session.end();

    expect(errors).toEqual([]);
    expect(finals.length).toBeGreaterThan(0);
    const transcript = finals.join(" ").toLowerCase();
    // The sentence came from clean TTS, so whisper should hear it clearly.
    expect(transcript).toContain("fox");
    expect(transcript).toContain("quick");
  });
});
