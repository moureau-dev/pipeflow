import type { ServerAdapter, ServerClient } from "../../types";

export interface BunWebSocketAdapterOptions {
  port: number;
  hostname?: string;
  path?: string;
  validateToken?: (token: string) => boolean | Promise<boolean>;
}

/**
 * Bun-native server adapter implementing `ServerAdapter`.
 * Creates a `Bun.serve()` WebSocket server and turns connections into
 * `ServerClient` instances.
 */
export class BunServerAdapter implements ServerAdapter {
  private readonly portOption: number;
  private readonly hostname: string;
  private readonly path: string;
  private readonly validateToken: ((token: string) => boolean | Promise<boolean>) | undefined;

  private server: ReturnType<typeof Bun.serve> | null = null;
  private connectionHandler: ((client: ServerClient) => void) | null = null;
  private actualPort = 0;

  constructor(options: BunWebSocketAdapterOptions) {
    this.portOption = options.port;
    this.hostname = options.hostname ?? "0.0.0.0";
    this.path = options.path ?? "/ws";
    this.validateToken = options.validateToken;
  }

  get url(): string {
    return `ws://${this.hostname}:${this.actualPort}${this.path}`;
  }

  onConnection(listener: (client: ServerClient) => void): () => void {
    this.connectionHandler = listener;
    return () => {
      this.connectionHandler = null;
    };
  }

  async start(): Promise<void> {
    const path = this.path;
    const validateToken = this.validateToken;
    const getHandler = () => this.connectionHandler;
    const clients = new Map<unknown, InternalServerClient>();

    this.server = Bun.serve({
      port: this.portOption,
      hostname: this.hostname,

      async fetch(req, server) {
        const url = new URL(req.url);
        if (url.pathname !== path) {
          return new Response("Not found", { status: 404 });
        }

        const token = url.searchParams.get("token");
        if (validateToken && !token) {
          return new Response("Authentication required", { status: 401 });
        }
        if (validateToken && token) {
          const valid = await validateToken(token);
          if (!valid) {
            return new Response("Invalid token", { status: 403 });
          }
        }

        const upgraded = server.upgrade(req, { data: {} });
        if (!upgraded) {
          return new Response("Upgrade failed", { status: 400 });
        }
      },

      websocket: {
        open(ws) {
          const handler = getHandler();
          if (!handler) return;
          const client = createBunClient(ws);
          clients.set(ws, client);
          handler(client);
        },

        message(ws, message) {
          const client = clients.get(ws);
          if (!client) return;
          if (typeof message === "string") {
            client.dispatchMessage(message);
          } else {
            client.dispatchBinary(
              message instanceof Uint8Array
                ? message
                : new Uint8Array((message as { buffer: ArrayBuffer }).buffer),
            );
          }
        },

        close(ws) {
          const client = clients.get(ws);
          if (client) client.dispatchClose();
          clients.delete(ws);
        },
      },
    });

    this.actualPort = this.server.port ?? 0;
  }

  async stop(): Promise<void> {
    if (this.server) {
      this.server.stop(true);
      this.server = null;
    }
  }
}

interface InternalServerClient extends ServerClient {
  dispatchMessage(data: string): void;
  dispatchBinary(data: Uint8Array): void;
  dispatchClose(): void;
}

function createBunClient(ws: { send(data: string | Uint8Array): void; close(): void }): InternalServerClient {
  const messageListeners = new Set<(data: string | Uint8Array) => void>();
  const closeListeners = new Set<() => void>();

  const client: InternalServerClient = {
    send(data: string): void {
      try { ws.send(data); } catch { /* closing */ }
    },
    sendBinary(data: Uint8Array): void {
      try { ws.send(data); } catch { /* closing */ }
    },
    close(): void {
      try { ws.close(); } catch { /* closing */ }
    },
    onMessage(listener): () => void {
      messageListeners.add(listener);
      return () => messageListeners.delete(listener);
    },
    onClose(listener): () => void {
      closeListeners.add(listener);
      return () => closeListeners.delete(listener);
    },
    dispatchMessage(data: string): void {
      for (const listener of [...messageListeners]) listener(data);
    },
    dispatchBinary(data: Uint8Array): void {
      for (const listener of [...messageListeners]) listener(data);
    },
    dispatchClose(): void {
      for (const listener of [...closeListeners]) listener();
    },
  };

  return client;
}