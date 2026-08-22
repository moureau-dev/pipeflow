// Pipeflow WebSocket chat example — voice in, voice out, one Bun process.
//
//   OPENROUTER_API_KEY=... bun run example/server.ts
//   → open http://localhost:3000
//
// Stack (all via OpenRouter):
//   STT  openai/whisper-large-v3-turbo   — batch, so the adapter buffers the
//         mic stream and transcribes a clip once `silenceMs` of silence has
//         passed (no partials; a turn arrives whole at the `final` event).
//         Whisper hallucination filtering is on by default: near-silence
//         "Thank you." / "E aí." fillers and *stage directions* are dropped,
//         and a clip-level energy floor (`minClipRms`) skips near-silence
//         clips before they are even transcribed. Whisper's language
//         auto-detection can drift to unrelated scripts on short/quiet clips
//         (Portuguese → Japanese/Korean gibberish); set `STT_LANGUAGE` to an
//         ISO-639-1 code (e.g. `STT_LANGUAGE=pt`) to pin the language. Unset
//         = provider-side detection.
//   LLM  meta-llama/llama-4-scout        — native tool calling (the default).
//   TTS  fish-audio/s2.1-pro-free:free   — the SpeechPipeline buffers the LLM
//         deltas into sentences and pre-starts the next sentence's synthesis
//         while the current one is still streaming, delivering in order. The
//         adapter is set to mp3 (self-describing sample rate) and a large
//         chunk size, so each sentence arrives as one binary frame the client
//         can decode at the provider's real rate.
//
// Barge-in: when the user speaks over the agent, the server aborts the
// generation/synthesis and forwards an `interrupt` message; the client cuts
// its playback queue immediately (and also stops the moment the mic hears
// the user).
//
// Tools: the agent's `get_weather` tool auto-executes — the orchestrator
// runs it and feeds the result back (no `tool-call` handler needed).

import index from "./client/index.html";
import { Agent } from "../src/agents/agent";
import { Conversation } from "../src/conversations/conversation/conversation";
import { MemoryPersistence } from "../src/persistence/adapters/memory/memory";
import { OpenRouterLLM } from "../src/providers/llm/adapters/openrouter/openrouter";
import { OpenRouterSTT } from "../src/providers/stt/adapters/openrouter/openrouter";
import { OpenRouterTTS } from "../src/providers/tts/adapters/openrouter/openrouter";
import { Pipeflow, Tool } from "../src";
import { z } from "zod";

const apiKey = process.env.OPENROUTER_API_KEY;
if (!apiKey) {
    console.error("OPENROUTER_API_KEY is required");
    process.exit(1);
}

const USER_ID = "user";
const stt = new OpenRouterSTT({
    apiKey,
    silenceMs: 700,
    // Unset = whisper auto-detects the language. Pin it with an ISO-639-1
    // code when detection drifts: `STT_LANGUAGE=pt bun run example/server.ts`.
    language: process.env.STT_LANGUAGE,
    // Energy floor: clips whose mean RMS is below this (near-silence — the
    // ones whisper hallucinates "E aí." / "Thank you." on) are dropped
    // without a transcription request. Raise if artifacts persist, lower if
    // quiet speech gets eaten. The client's VAD gates what is *sent*; this
    // gates what is *transcribed*. The client's slider tunes it live.
    minClipRms: 0.02,
    // Broadcast every clip's measured energy so the client can show where
    // speech vs. artifacts land and the slider can be set against reality.
    onClipEnergy: (rms, transcribed) => {
        const msg = JSON.stringify({ type: "clip-energy", rms, transcribed });
        for (const client of clients) client.send(msg);
    },
});
const tts = new OpenRouterTTS({
    apiKey,
    format: "mp3",
    chunkSize: 1_000_000,
    voice: "alloy",
});
const llm = new OpenRouterLLM({
    apiKey,
    model: "meta-llama/llama-4-scout",
    toolMode: "native",
});

const pipeflow = new Pipeflow({
    llm,
    stt,
    tts,
});

const weatherTool = new Tool({
    name: "get_weather",
    description: "Returns the current weather in celsius",
    schema: {
        in: z.object({
            city: z.string().describe("city to check the weather in celsius"),
        }),
    },
    execute: async ({ city }) => {
        return `20°C`;
    },
});

const agent = pipeflow.agent({
    name: "Scout",
    context:
        "You are a concise, friendly voice assistant. Keep replies to 2-3 short sentences.",
    tools: [weatherTool],
});

const conversation = await pipeflow.conversations.create({
    agents: [agent],
});

await conversation.participate({ userId: USER_ID, aliases: ["you"] });
// start() attaches the orchestrator automatically (STT → turns → LLM → TTS).
await conversation.start();

// The agent's tools auto-execute: the orchestrator runs `get_weather` and
// feeds the result back into the generation. `tool-call` events still fire
// for app visibility (logging, telemetry) — resolve manually only with
// `autoExecuteTools: false` on the Pipeflow instance or `create()`.

console.log("Pipeflow voice chat — whisper → llama-4-scout → fish s2.1 (free)");

// Connected browsers, for broadcasting STT clip-energy readings to the slider.
// Structural type: Bun's ServerWebSocket satisfies it without importing Bun types.
const clients = new Set<{ send(data: string): void }>();

const server = Bun.serve<{ unsubscribe: (() => void)[] }>({
    port: 3000,
    routes: { "/": index },

    fetch(req, server) {
        if (new URL(req.url).pathname === "/ws") {
            if (server.upgrade(req, { data: { unsubscribe: [] } })) return;
            return new Response("Upgrade failed", { status: 400 });
        }
        return new Response("Not found", { status: 404 });
    },

    websocket: {
        open(ws) {
            clients.add(ws);
            // Tell the client the server's current floor so the slider starts
            // in sync.
            ws.send(
                JSON.stringify({ type: "minClipRms", value: stt.minClipRms ?? 0 }),
            );
            // Forward the conversation's events to this client. Audio goes out as
            // binary — one mp3 frame per synthesized sentence — plus JSON control
            // messages. The unsubscribe list rides along on `ws.data`.
            ws.data.unsubscribe.push(
                conversation.on("turn", ({ turn }) =>
                    ws.send(JSON.stringify({ type: "turn", text: turn.text })),
                ),
                conversation.on("text-delta", ({ text }) =>
                    ws.send(JSON.stringify({ type: "delta", text })),
                ),
                conversation.on("transcript", ({ entry }) => {
                    if (entry.speakerKind === "agent") {
                        ws.send(
                            JSON.stringify({ type: "done", text: entry.text }),
                        );
                    }
                }),
                conversation.on("audio", ({ audio }) => ws.send(audio.data)),
                // Barge-in/stop: the server aborted the generation and synthesis, so
                // the client should cut whatever it is still playing or has queued.
                conversation.on("interrupt", () =>
                    ws.send(JSON.stringify({ type: "interrupt" })),
                ),
                conversation.on("error", ({ error }) =>
                    ws.send(
                        JSON.stringify({
                            type: "error",
                            message: error.message,
                        }),
                    ),
                ),
            );
        },

        message(ws, message) {
            if (typeof message === "string") {
                // JSON control messages: { type: "text", text } for typed turns,
                // { type: "minClipRms", value } to tune the STT energy floor.
                try {
                    const data = JSON.parse(message);
                    if (data.type === "text" && typeof data.text === "string") {
                        conversation.send({ userId: USER_ID, text: data.text });
                    } else if (
                        data.type === "minClipRms" &&
                        typeof data.value === "number" &&
                        Number.isFinite(data.value)
                    ) {
                        stt.minClipRms = Math.max(0, Math.min(0.5, data.value));
                    }
                } catch {
                    // Ignore malformed frames.
                }
                return;
            }
            // Binary = raw linear16 PCM (16 kHz mono) from the client mic. The STT
            // adapter buffers it and transcribes a clip after `silenceMs` of no
            // audio, so utterances are segmented without streaming STT.
            conversation.listen({
                userId: USER_ID,
                audio: new Uint8Array(message),
            });
        },

        close(ws) {
            clients.delete(ws);
            for (const unsubscribe of ws.data?.unsubscribe ?? []) unsubscribe();
        },
    },
});

console.log(`Listening on http://localhost:${server.port}`);
