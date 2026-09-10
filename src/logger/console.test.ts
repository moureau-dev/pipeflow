import { describe, expect, test } from "bun:test";
import { ConsoleLogger, SilentLogger } from "./console";
import type { Logger } from "./types";

describe("ConsoleLogger", () => {
  test("implements Logger interface", () => {
    const logger: Logger = new ConsoleLogger("test");
    expect(typeof logger.info).toBe("function");
    expect(typeof logger.warn).toBe("function");
    expect(typeof logger.error).toBe("function");
    expect(typeof logger.debug).toBe("function");
  });
});

describe("SilentLogger", () => {
  test("implements Logger interface and never throws", () => {
    const logger: Logger = new SilentLogger();
    expect(() => logger.info("test")).not.toThrow();
    expect(() => logger.warn("test")).not.toThrow();
    expect(() => logger.error("test")).not.toThrow();
    expect(() => logger.debug("test")).not.toThrow();
  });

  test("accepts all arguments without error", () => {
    const logger = new SilentLogger();
    expect(() => logger.info("message", { key: "value" })).not.toThrow();
    expect(() => logger.warn("message", { count: 42 })).not.toThrow();
    expect(() => logger.error("error", { err: "something" })).not.toThrow();
    expect(() => logger.debug("debug", { data: null })).not.toThrow();
  });
});

describe("ConsoleLogger constructor", () => {
  test("accepts optional name", () => {
    const logger = new ConsoleLogger("myapp");
    expect(logger).toBeDefined();
  });

  test("works without name", () => {
    const logger = new ConsoleLogger();
    expect(logger).toBeDefined();
  });
});