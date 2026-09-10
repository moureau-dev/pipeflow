import type { Conversation } from "../../../conversations/conversation/conversation";
import type { UserId } from "../../../conversations/types";
import type { Logger } from "../../../logger/types";
import type { ServerAdapter, ServerClient } from "../../types";

export interface ConversationWebSocketServerOptions {
  conversation: Conversation;
  /**
   * The server transport adapter. Pass `BunServerAdapter` for Bun,
   * or implement `ServerAdapter` for socket.io / node-ws / etc.
   *
   * ```ts
   * const adapter = new BunServerAdapter({ port: 3000 });
   * const server = new ConversationWebSocketServer({ conversation, adapter });
   * await server.start();
   * ```
   */
  adapter: ServerAdapter;
  /**
   * Extracts the user id from an incoming connection. The default reads the
   * `userId` query parameter from the URL (BunAdapter) or returns "user".
   * Override to extract from headers, a JWT token, or a socket.io handshake.
   */
  resolveUserId?: (client: ServerClient) => UserId | Promise<UserId>;
  /**
   * Optional token validator. Return `true` to accept the connection,
   * `false` to reject. The resolved token value is read from the
   * `?token=` query parameter by the default `BunServerAdapter`.
   */
  validateToken?: (token: string) => boolean | Promise<boolean>;
  /** Default user id when `resolveUserId` returns nothing. Defaults to `"user"`. */
  defaultUserId?: UserId;
  /** Token query param name. Defaults to `"token"`. Used by the default resolveUserId. */
  tokenParam?: string;
  logger?: Logger;
}

/**
 * Bridges a Pipeflow `Conversation` to any server runtime via the
 * `ServerAdapter` interface.
 *
 * The server speaks the same `ProtocolMessage` wire format the client-side
 * `WebSocketProtocol` uses: JSON envelopes with `type` and `payload` fields,
 * plus raw binary frames for audio.
 *
 * **Bun:**
 * ```ts
 * import { BunServerAdapter } from "@moureau/pipeflow/transport";
 *
 * const adapter = new BunServerAdapter({ port: 3000, path: "/ws" });
 * const server = new ConversationWebSocketServer({ conversation, adapter });
 * await server.start();
 * ```
 *
 * **socket.io (write your own adapter):**
 * ```ts
 * class SocketIOServerAdapter implements ServerAdapter {
 *   // wrap socket.io here
 * }
 * ```
 */
export class ConversationWebSocketServer {
  private readonly conversation: Conversation;
  private readonly adapter: ServerAdapter;
  private readonly resolveUserId: (client: ServerClient) => UserId | Promise<UserId>;
  private readonly defaultUserId: UserId;
  private readonly logger: Logger;

  private started = false;
  private readonly clients = new Map<ServerClient, { userId: UserId; unsubscribe: (() => void)[] }>();

  constructor(options: ConversationWebSocketServerOptions) {
    this.conversation = options.conversation;
    this.adapter = options.adapter;
    this.defaultUserId = options.defaultUserId ?? "user";
    this.logger = options.logger ?? { info() {}, warn() {}, error() {}, debug() {} } as Logger;
    this.resolveUserId = options.resolveUserId ?? ((_client) => this.defaultUserId);
  }

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;

    const conversation = this.conversation;
    const logger = this.logger;

    this.adapter.onConnection((client) => this.handleConnection(client));

    await this.adapter.start();

    logger.info("conversation websocket server started", {
      conversationId: conversation.id,
    });
  }

  private async handleConnection(client: ServerClient): Promise<void> {
    const conversation = this.conversation;
    const logger = this.logger;

    const userIdOrPromise = this.resolveUserId(client);
    const userId = userIdOrPromise instanceof Promise ? await userIdOrPromise : userIdOrPromise;

    logger.info("client connected", { conversationId: conversation.id, userId });

    conversation.participate({ userId }).catch((err) => {
      logger.error("failed to add participant", { userId, error: String(err) });
    });

    const sendJson = (type: string, payload: unknown) => {
      client.send(JSON.stringify({ type, payload }));
    };

    const unsubscribes: (() => void)[] = [
      conversation.on("start", ({ conversationId }) =>
        sendJson("start", { conversationId }),
      ),
      conversation.on("stop", ({ conversationId }) =>
        sendJson("stop", { conversationId }),
      ),
      conversation.on("turn", ({ turn }) =>
        sendJson("turn", { conversationId: conversation.id, turn }),
      ),
      conversation.on("transcript", ({ entry }) =>
        sendJson("transcript", { conversationId: conversation.id, entry }),
      ),
      conversation.on("partial-transcript", ({ userId: uid, text }) =>
        sendJson("partial-transcript", { conversationId: conversation.id, userId: uid, text }),
      ),
      conversation.on("generation", ({ generation }) =>
        sendJson("generation", { conversationId: conversation.id, generation }),
      ),
      conversation.on("generation-complete", ({ generation }) =>
        sendJson("generation-complete", { conversationId: conversation.id, generation }),
      ),
      conversation.on("text-delta", ({ text, agentName }) =>
        sendJson("text-delta", { conversationId: conversation.id, text, agentName }),
      ),
      conversation.on("audio", ({ audio }) => {
        client.sendBinary(audio.data);
      }),
      conversation.on("tool-call", ({ call }) =>
        sendJson("tool-call", { conversationId: conversation.id, call }),
      ),
      conversation.on("tool-call-result", ({ result }) =>
        sendJson("tool-call-result", { conversationId: conversation.id, result }),
      ),
      conversation.on("interrupt", () =>
        sendJson("interrupt", { conversationId: conversation.id }),
      ),
      conversation.on("error", ({ error }) =>
        sendJson("error", { conversationId: conversation.id, message: error.message }),
      ),
      conversation.on("state", ({ state }) =>
        sendJson("state", { conversationId: conversation.id, state }),
      ),
    ];

    this.clients.set(client, { userId, unsubscribe: unsubscribes });

    client.onMessage((data) => this.handleMessage(client, userId, data));
    client.onClose(() => this.handleClose(client, userId));
  }

  private handleMessage(_client: ServerClient, userId: UserId, data: string | Uint8Array): void {
    if (typeof data !== "string") {
      this.conversation.listen({ userId, audio: data });
      return;
    }
    let parsed: { type?: string; payload?: unknown };
    try {
      parsed = JSON.parse(data);
    } catch {
      return;
    }
    if (!parsed.type) return;
    const payload = parsed.payload as Record<string, unknown> | undefined;

    switch (parsed.type) {
      case "text-in": {
        const text = typeof payload?.text === "string" ? payload.text : "";
        if (text) this.conversation.send({ userId, text });
        break;
      }
      case "interrupt":
        this.conversation.interrupt();
        break;
      case "tool-result": {
        if (payload?.result && typeof payload.result === "object") {
          this.conversation.resolveToolCall(payload.result as never);
        }
        break;
      }
      default:
        break;
    }
  }

  private handleClose(client: ServerClient, userId: UserId): void {
    const entry = this.clients.get(client);
    if (entry) {
      for (const unsub of entry.unsubscribe) unsub();
      this.clients.delete(client);
    }
    this.logger.info("client disconnected", {
      conversationId: this.conversation.id,
      userId,
    });
  }

  async stop(): Promise<void> {
    if (!this.started) return;
    this.started = false;
    for (const [, entry] of this.clients) {
      for (const unsub of entry.unsubscribe) unsub();
    }
    this.clients.clear();
    await this.adapter.stop();
    this.logger.info("conversation websocket server stopped", {
      conversationId: this.conversation.id,
    });
  }
}