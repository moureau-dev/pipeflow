/**
 * Scoped key-value store attached to a conversation. Values are rendered
 * as system messages before every generation so the LLM has access to
 * ephemeral app state (current file, user role, mode).
 *
 * Updated independently of turns -- useful for state that changes
 * without a new user message (navigation, toggles, auth changes).
 */
export class Annotations {
  private store = new Map<string, string>();

  /** Set a single annotation key to a value. */
  set(key: string, value: string): void;
  /** Set multiple annotations at once. */
  set(entries: Record<string, string>): void;
  set(keyOrEntries: string | Record<string, string>, value?: string): void {
    if (typeof keyOrEntries === "string") {
      this.store.set(keyOrEntries, value!);
    } else {
      for (const [k, v] of Object.entries(keyOrEntries)) {
        this.store.set(k, v);
      }
    }
  }

  /** Remove a single annotation by key. */
  delete(key: string): void {
    this.store.delete(key);
  }

  /** Remove all annotations. */
  clear(): void {
    this.store.clear();
  }

  /** Live view of all annotations. Updated in place. */
  get entries(): ReadonlyMap<string, string> {
    return this.store;
  }

  /** Number of annotations. */
  get size(): number {
    return this.store.size;
  }
}