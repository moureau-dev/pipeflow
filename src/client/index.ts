/**
 * Browser/client SDK for talking to a Pipeflow server.
 *
 * The client is intentionally tiny: a typed event surface that mirrors
 * `Conversation`, backed by a swappable wire protocol. It knows nothing about
 * STT/LLM/TTS: it forwards your input and surfaces what comes back.
 *
 * ```ts
 * import { PipeflowClient, WebSocketProtocol } from "@moureau/pipeflow/client";
 *
 * const client = new PipeflowClient({
 *   protocol: new WebSocketProtocol({
 *     url: "wss://api.example.com/conversations/abc",
 *     token: () => localStorage.getItem("jwt"),
 *   }),
 *   audio: { input: true },
 * });
 *
 * client.on("transcript", (e) => render(e.entry.text));
 * client.on("audio", (e) => client.playAudio(e.audio));
 * await client.connect();
 * await client.sendText("hello", { userId: "alice" });
 * ```
 *
 * @packageDocumentation
 */

export { PipeflowClient } from "./client";
export type {
  PipeflowClientOptions,
  PipeflowClientEvent,
  PipeflowClientEventMap,
  Listener,
  ReconnectOptions,
  AudioInputOptions,
  CaptureConstraints,
} from "./client";

export type {
  Protocol,
  ProtocolStatus,
  ProtocolMessage,
  ProtocolListener,
  StatusListener,
} from "./protocol";

export { WebSocketProtocol } from "./protocol/websocket";
export type {
  WebSocketProtocolOptions,
  TokenProvider,
} from "./protocol/websocket";