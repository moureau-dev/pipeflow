import type { Message, Transport } from "../../types";

/**
 * In-process transport used for tests and development.
 *
 * A `MemoryTransport` is always half of a connection: messages sent on one
 * end are delivered to the listeners of the peer end. Use `pair()` to create
 * two connected ends, or `MemoryTransport.pair()` directly.
 */
export class MemoryTransport implements Transport {
  private peer: MemoryTransport | null = null;
  private readonly listeners = new Set<(message: Message) => void>();
  private closed = false;

  /** Create a pair of connected transports. */
  static pair(): [MemoryTransport, MemoryTransport] {
    const a = new MemoryTransport();
    const b = new MemoryTransport();
    a.peer = b;
    b.peer = a;
    return [a, b];
  }

  get isClosed(): boolean {
    return this.closed;
  }

  send(message: Message): void {
    if (this.closed) {
      throw new Error("Cannot send on a closed transport");
    }
    const peer = this.peer;
    if (!peer) {
      throw new Error("Transport has no peer to send to");
    }
    if (peer.closed) {
      throw new Error("Cannot send to a closed peer transport");
    }
    peer.deliver(message);
  }

  onMessage(listener: (message: Message) => void): () => void {
    if (this.closed) {
      throw new Error("Cannot subscribe to a closed transport");
    }
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.listeners.clear();
    const peer = this.peer;
    this.peer = null;
    if (peer && !peer.closed) {
      await peer.close();
    }
  }

  private deliver(message: Message): void {
    for (const listener of [...this.listeners]) {
      try {
        listener(message);
      } catch {
        // A faulty listener must not prevent delivery to the others.
      }
    }
  }
}
