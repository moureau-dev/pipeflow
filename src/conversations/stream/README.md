# ConversationStream

The conversation's semantic reply stream. It turns the event surface
(`text-delta` → fragments, `generation-complete` → done) into a
[`FieldStream`](../../transport/streamobject/field-stream/field-stream.ts)
completion API: consumers act on partial reply text without waiting for the
generation to finish.

```ts
const replies = new ConversationStream(conversation);
replies.whenItem("text", (fragment, index) => render(fragment));
replies.when("agent", (agent) => showSpeaker(agent));
replies.whenObjectDone((reply) => finalize(reply));
replies.cancel(); // interrupts the current generation (stops the LLM)
```

- **One object per top-level generation** (agent or coordination reply).
  Delegated specialist transcripts do not terminate it — only the top-level
  `generation-complete` does.
- **`text` is an ordered sequence of completed text fragments**, not provider
  packets; the fragments join exactly to the generation's text.
- **Lifecycle per object:** `STREAMING → DONE | CANCELLED | FAILED`. Completion
  events fire at most once per boundary and never after a terminal state;
  `cancel()` is idempotent and is not an error.
- Interruptions and provider errors leave already-delivered fragments as valid
  partial state; the next generation starts a fresh object.

`ConversationStream` is experimental, like the rest of the streamobject module
— see the [transport README](../../transport/README.md) for status and the
[protocol spec](../../transport/streamobject/README.md) for the underlying
semantic model.
