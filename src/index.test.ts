import { describe, expect, test } from "bun:test";
import {
  Agent,
  Conversation,
  Conversations,
  PipeflowTool,
  Tool,
  Transcription,
  TranscriptEntry,
} from "./index";
import {
  DeepSeekLLM,
  DeepgramSTT,
  KokoroTTS,
  complete,
  streamText,
} from "./providers/index";
import { MemoryPersistence, SQLitePersistence } from "./persistence/index";
import { MemoryTransport } from "./transport/index";

describe("public exports", () => {
  test("PipeflowTool is an alias of Tool", () => {
    const tool = new PipeflowTool({
      name: "get_weather",
      description: "Weather",
      execute: () => "sunny",
    });
    expect(tool).toBeInstanceOf(Tool);
  });

  test("core classes are exported", () => {
    expect(typeof Agent).toBe("function");
    expect(typeof Conversation).toBe("function");
    expect(typeof Conversations).toBe("function");
    expect(typeof Transcription).toBe("function");
    expect(typeof TranscriptEntry).toBe("function");
    expect(typeof Tool).toBe("function");
  });

  test("provider and adapter implementations are exported from subpaths", () => {
    expect(DeepSeekLLM.name).toBe("DeepSeekLLM");
    expect(DeepgramSTT.name).toBe("DeepgramSTT");
    expect(KokoroTTS.name).toBe("KokoroTTS");
    expect(MemoryPersistence.name).toBe("MemoryPersistence");
    expect(SQLitePersistence.name).toBe("SQLitePersistence");
    expect(MemoryTransport.name).toBe("MemoryTransport");
    expect(typeof complete).toBe("function");
    expect(typeof streamText).toBe("function");
  });

  test("the main entry does not leak implementation detail", async () => {
    const index = await import("./index.ts");
    expect("DeepSeekLLM" in index).toBe(false);
    expect("DeepgramSTT" in index).toBe(false);
    expect("KokoroTTS" in index).toBe(false);
    expect("SQLitePersistence" in index).toBe(false);
    expect("MemoryPersistence" in index).toBe(false);
    expect("MemoryTransport" in index).toBe(false);
    expect("Orchestrator" in index).toBe(false);
    expect("complete" in index).toBe(false);
    expect("streamText" in index).toBe(false);
  });
});
