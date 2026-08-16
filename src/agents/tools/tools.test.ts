import { describe, expect, test } from "bun:test";
import { Tool } from "./tools";

describe("Tool", () => {
  test("stores name, description and parameters", () => {
    const tool = new Tool({
      name: "get_weather",
      description: "Get the current weather for a city.",
      parameters: { type: "object", properties: { city: { type: "string" } } },
      execute: async () => "sunny",
    });

    expect(tool.name).toBe("get_weather");
    expect(tool.description).toBe("Get the current weather for a city.");
    expect(tool.parameters).toEqual({
      type: "object",
      properties: { city: { type: "string" } },
    });
  });

  test("trims whitespace around name and description", () => {
    const tool = new Tool({
      name: "  get_weather  ",
      description: "  Get the weather.  ",
      execute: () => "sunny",
    });
    expect(tool.name).toBe("get_weather");
    expect(tool.description).toBe("Get the weather.");
  });

  test("rejects an empty or whitespace-only name", () => {
    expect(
      () =>
        new Tool({
          name: "   ",
          description: "desc",
          execute: () => "x",
        }),
    ).toThrow(/non-empty name/);
    expect(
      () =>
        new Tool({
          name: "",
          description: "desc",
          execute: () => "x",
        }),
    ).toThrow(/non-empty name/);
  });

  test("rejects an empty description", () => {
    expect(
      () =>
        new Tool({
          name: "get_weather",
          description: "",
          execute: () => "x",
        }),
    ).toThrow(/non-empty description/);
  });

  test("passes the exact arguments through to execute", async () => {
    let received: unknown;
    const tool = new Tool<{ city: string }, string>({
      name: "get_weather",
      description: "Weather",
      execute: (args) => {
        received = args;
        return `weather for ${args.city}`;
      },
    });

    const result = await tool.execute({ city: "Paris" });

    expect(received).toEqual({ city: "Paris" });
    expect(result).toBe("weather for Paris");
  });

  test("resolves a synchronous return value", async () => {
    const tool = new Tool({
      name: "ping",
      description: "Ping",
      execute: () => "pong",
    });
    expect(await tool.execute({})).toBe("pong");
  });

  test("resolves an async return value", async () => {
    const tool = new Tool({
      name: "slow",
      description: "Slow",
      execute: async () => {
        await Bun.sleep(1);
        return 42;
      },
    });
    expect(await tool.execute({})).toBe(42);
  });

  test("a synchronous throw becomes a rejection", async () => {
    const tool = new Tool({
      name: "boom",
      description: "Boom",
      execute: () => {
        throw new Error("sync failure");
      },
    });
    await expect(tool.execute({})).rejects.toThrow("sync failure");
  });

  test("an async rejection propagates", async () => {
    const tool = new Tool({
      name: "boom",
      description: "Boom",
      execute: async () => {
        throw new Error("async failure");
      },
    });
    await expect(tool.execute({})).rejects.toThrow("async failure");
  });
});
