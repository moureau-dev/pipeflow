import { describe, expect, test } from "bun:test";
import { BunServerAdapter } from "./bun-server";

const HOST = "127.0.0.1";

describe("BunServerAdapter", () => {
  test("start and stop lifecycle", async () => {
    const adapter = new BunServerAdapter({ port: 0, hostname: HOST });
    await adapter.start();
    expect(adapter.url).toMatch(/^ws:\/\/127\.0\.0\.1:\d+\/ws$/);
    await adapter.stop();
  });

  test("onConnection fires when a client connects", async () => {
    const adapter = new BunServerAdapter({ port: 0, hostname: HOST });
    await adapter.start();

    const connections: number[] = [];
    adapter.onConnection(() => connections.push(1));

    const ws = new WebSocket(adapter.url);
    await new Promise<void>((resolve, reject) => {
      ws.onopen = () => resolve();
      ws.onerror = () => reject(new Error("connection failed"));
      setTimeout(() => reject(new Error("timeout")), 2000);
    });
    ws.close();

    expect(connections.length).toBe(1);
    await adapter.stop();
  });

  test("ServerClient can send and receive messages", async () => {
    const adapter = new BunServerAdapter({ port: 0, hostname: HOST });
    await adapter.start();

    const receivedMessages: string[] = [];
    adapter.onConnection((client) => {
      client.onMessage((data) => {
        if (typeof data === "string") receivedMessages.push(data);
      });
      client.send('{"type":"welcome"}');
    });

    const ws = new WebSocket(adapter.url);
    await new Promise<void>((resolve, reject) => {
      ws.onmessage = (event) => {
        if (event.data === '{"type":"welcome"}') {
          ws.send('{"type":"hello"}');
          // Wait for server to process before checking
          setTimeout(resolve, 100);
        }
      };
      ws.onerror = () => reject(new Error("connection failed"));
      setTimeout(() => reject(new Error("timeout")), 2000);
    });

    ws.close();
    expect(receivedMessages).toContain('{"type":"hello"}');
    await adapter.stop();
  });

  test("stops accepting after stop()", async () => {
    const adapter = new BunServerAdapter({ port: 0, hostname: HOST });
    await adapter.start();
    const url = adapter.url;
    await adapter.stop();

    let error: unknown = null;
    try {
      const ws = new WebSocket(url);
      await new Promise((_, reject) => {
        ws.onerror = () => reject(new Error("expected failure"));
        ws.onopen = () => reject(new Error("should not have connected"));
        setTimeout(() => reject(new Error("timeout")), 2000);
      });
    } catch (e) {
      error = e;
    }
    expect(error).not.toBeNull();
  });

  test("validateToken rejects unauthorized connections", async () => {
    const adapter = new BunServerAdapter({
      port: 0,
      hostname: HOST,
      validateToken: (token) => token === "secret",
    });
    await adapter.start();

    let authorized = false;
    adapter.onConnection(() => { authorized = true; });

    const badUrl = adapter.url + "?token=wrong";
    const ws = new WebSocket(badUrl);
    let failed = false;
    await new Promise<void>((resolve) => {
      ws.onerror = () => { failed = true; resolve(); };
      ws.onopen = () => resolve();
      setTimeout(() => resolve(), 2000);
    });
    expect(authorized).toBe(false);
    expect(failed).toBe(true);

    await adapter.stop();
  });
});