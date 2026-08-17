# StreamObject Protocol — Specification v0.1 (draft)

This README is the specification for the **experimental** module in this
directory: a schema-bound streaming semantic protocol (wire codec, JSON
adapter, `StreamObject` consumer API). It is not part of the public API — see
the [transport README](../README.md) for the supported surface.

**Status.** Normative for v0.1: the frozen items below. Deferred items are
explicitly out of scope; implementations must not assume them. This document is
the protocol; encodings are projections of it.

**Frozen (v0.1).** Abstract record model · opaque payloads · canonical typed
payloads · record atomicity · per-field ordering · field lifecycle · object
lifecycle · schema · arrays: one `FIELD_APPEND` = one complete item (no item
fragmentation) · resource limits as invariants · one producer per field ·
borrow/copy lifetimes · reference text encoding.

**Deferred.** Binary opcode layout · nested object fields · stream fields ·
merge semantics · abort reason payloads · session flow control · schema
evolution beyond append-at-end.

## 1. Abstract record model

A stream is a sequence of records. There are exactly four record types.
Encodings (text, binary) are projections of this model — the abstract protocol
does not know that `!id;` "means" completion.

| Record | Arguments | Semantics |
| --- | --- | --- |
| `FIELD_APPEND` | `field_id`, `payload` | Scalar field: append a payload *fragment* to the field accumulation. Array field: append **one complete array item**. |
| `FIELD_COMPLETE` | `field_id` | Close the field. Consumer receives exactly one field-completion event with the accumulated value. |
| `OBJECT_COMPLETE` | — | Close the object successfully. Fields not yet completed are *absent* from the materialized object. |
| `OBJECT_ABORT` | — | Discard the object. Consumer receives an abort event; the object is not successful, regardless of earlier field completions. |

> Array items are not fragmented in v0.1. A single `FIELD_APPEND` constitutes
> one complete array item. Fragmented array items require a future record
> extension.

### 1.1 Payloads are opaque byte sequences

The abstract protocol does not interpret payload bytes; interpretation is a
function of the schema and the canonical typed payloads (§2.1). A decoder
without a schema can validate only length, not content. The reference text
encoding transmits string payloads as UTF-16 code units (it is a JS-oriented
reference); the binary encoding will use UTF-8 byte lengths.

### 1.2 Record atomicity

- A record is atomic only when its **complete payload** has been received.
- Transport fragmentation has no semantic meaning: a record split across N
  transport chunks is indistinguishable from the same record in one chunk; two
  records in one transport chunk are indistinguishable from the same records in
  separate chunks.
- A record's payload bytes reach the accumulation in order. Nothing else is
  guaranteed across records.
- Non-normative framing guidance: message transports (WebSocket, in-memory) may
  carry one record per message; byte streams should length-prefix records for
  resynchronization. Neither changes the record model.

### 1.3 Ordering

- Appends to the same field are strictly ordered and cumulative: scalar
  `value = concat(payload_1 … payload_n)`; array `items = [payload_1, …, payload_n]`.
- Records for different fields may interleave arbitrarily.
- Field-completion events are delivered in **completion order**, never schema
  order. Consumers must not assume completion order.

## 2. Schema

A frozen, ordered array of field definitions. Field ids are **positional
indices** into this array.

```js
[
  { path: ["name"], type: "string", maxLength: 256 },
  { path: ["age"], type: "integer", maxLength: 8 },
  { path: ["projects"], type: "string", mode: "array", maxItems: 64, maxLength: 128 },
]
```

- `path` — dot-path into the materialized object. Required. Two fields writing
  conflicting paths (scalar vs. object at the same path) is a schema error.
- `type` — `string` | `integer` | `number` | `boolean`. Required.
- `mode` — `"array"` or absent (scalar).
- `maxItems` — **required for array fields**. Exceeding it is a protocol error.
- `maxLength` — optional cap. For scalars: cap on the *accumulated* payload
  length. For arrays: cap on *each item's* payload length. Exceeding it is a
  protocol error.

Versioning: append-at-end is compatible; reorder/remove is breaking. Protocol
version + schema fingerprint are negotiated in the **session handshake**, never
carried per object.

### 2.1 Canonical typed payloads (normative)

| Type | Payload representation |
| --- | --- |
| `string` | any sequence of UTF-16 code units (text encoding) |
| `integer` | `-?(0|[1-9][0-9]*)`; must satisfy `Number.isSafeInteger`; `-0` rejected |
| `number` | JSON number grammar `-?(0|[1-9][0-9]*)(\.[0-9]+)?([eE][+-]?[0-9]+)?`; must be finite |
| `boolean` | `0` = false, `1` = true |

Explicitly rejected: leading zeros (`01`), exponents and hex for integers
(`1e3`, `0x10`), `-0` for integers, values outside the safe-integer range for
integers, and `"true"`/`"false"` for booleans. Decoders must not rely on
`Number()` coercion semantics; validation is lexical.

## 3. Field lifecycle

```
UNSEEN ──FIELD_APPEND──▶ STREAMING ──FIELD_APPEND──▶ STREAMING
   │                        │
   │                        └──FIELD_COMPLETE──▶ DONE
```

For arrays, `FIELD_APPEND` advances from UNSEEN to STREAMING on the first item;
`FIELD_COMPLETE` delivers the completed array (`[]` when completed with zero
items).

Protocol errors:

| Situation | Verdict |
| --- | --- |
| `FIELD_APPEND` on `DONE` | error |
| `FIELD_COMPLETE` on `DONE` (duplicate) | error |
| `FIELD_APPEND` / `FIELD_COMPLETE` on unknown id (≥ fieldCount) | error |
| `FIELD_COMPLETE` on `UNSEEN` | legal **only** for `string` and `array` (empty value: `""` / `[]`); error for `integer`/`number`/`boolean` — an empty typed value is not representable |

## 4. Object lifecycle

```
acquisition ──▶ records ──▶ OBJECT_COMPLETE  → success; materialized object = exactly the DONE fields
                records ──▶ OBJECT_ABORT     → failure; state discarded
```

- A codec decodes exactly **one object per acquisition**.
- Field-completion events are the only exposure of partial state; each is
  independently usable.
- After `OBJECT_COMPLETE` or `OBJECT_ABORT`, the codec is done; the next object
  requires release + re-acquire (pool).
- `OBJECT_COMPLETE` with fields still streaming is legal: those fields are
  absent from the materialized object. Absent ≠ failed; failure is expressed
  only by `OBJECT_ABORT`.

## 5. Ownership

- **Each field has exactly one producer.** Two producers appending to the same
  field is a protocol error.
- The schema may optionally declare producers: `owners: ["llm-a", "llm-a", "stt", …]`,
  aligned with fields.
- Enforcement is optional: when the session identifies producers (per-producer
  push paths) *and* owners are declared, violations are protocol errors.
  Without declared owners, the rule is a contract, not a check.
- Merge semantics are explicitly out of scope.

## 6. Resource contract

- `maxLength` / `maxItems` are **protocol invariants**, not negotiation hints.
  A `FIELD_APPEND` that would exceed them is a protocol error; decoders reject
  before allocating beyond the limit.
- Per-codec worst-case live memory ≈
  `Σ maxLength + Σ(maxItems × maxLength) + chain fragmentation` (~chunk size
  per chain tail). Sessions size pools from this formula.
- Pool exhaustion (arena/chunk/codec) is a session-level error; recovery is
  codec release. Producer-side flow control is deferred to the transport layer
  (extension).

## 7. View lifetime (borrow vs. copy)

- The field-completion callback receives a **borrowed view** of the completed
  field.
- Borrowed access (raw chunk iteration, arena-backed reads) is valid **only
  until the codec releases its chunks** — i.e. until release/re-acquire. After
  that it is undefined behavior.
- Materialization is lazy: nothing is parsed until the consumer asks.
  Materializing readers return **owned** JS values; numeric readers parse
  directly from the arena (no intermediate string).
- View API (v0.1): `readString()`, `readInteger()`, `readNumber()`,
  `readBoolean()`, `copy()`, `forEachChunk(...)`. There is no `readJSON()`: the
  schema has no JSON type, and a string containing JSON is just a `string`.
- Rule of thumb: anything retained past the callback must be copied.

## 8. Reference text encoding

The canonical, normative reference for conformance. It is a projection of the
abstract model, not the protocol.

```
append      = field-id ":" length ":" payload ";"
complete    = "!" field-id ";"
object-end  = "!;"
abort       = "~;"
field-id    = 1*DIGIT
length      = 1*DIGIT
payload     = *UTF16-CODE-UNIT   ; exactly `length` units
```

- Length counts UTF-16 code units of the JS string.
- Surrogate pairs split across appends reassemble correctly (accumulation is
  code-unit based).
- Any two adjacent records may be joined or split without changing meaning (§1.2).
- Any byte violating the grammar at its position is a protocol error.

Example (interleaved, completion order ≠ schema order):

```
0:2:Al;1:2:27;2:6:Apollo;0:2:ex;!1;!0;2:5:Orion;!2;!;
```

```
onFieldDone(1, 27)                ; age
onFieldDone(0, "Alex")            ; name
onFieldDone(2, ["Apollo","Orion"]) ; projects
onObjectDone()
```

## 9. Binary encoding — deferred

Not specified in v0.1. Known requirements: same record model; UTF-8 byte
lengths; compact opcodes (~4–6 bytes overhead per record); abort reason payload
unresolved. Deliberately postponed until semantics stabilize.

## 10. Conformance

Goal: every implementation, given the same record sequence, produces the
identical event sequence and identical materialized objects.

- **Golden tests:** `wire → decoder → events → materialized object`.
- **Property test (load-bearing):** generate random logical event sequences;
  derive canonical materialization; fragment the wire form at random points;
  decode; assert same events and same materialized object. Run over millions of
  sequences, including split-at-every-character cases.
- **Executable spec:** the reference implementation in
  `src/transport/streamobject/reference.ts` (plus `reference.test.ts`) is the
  conformance harness. Every implementation — including the future
  arena-backed receiver — must satisfy:

```
push(fragment(encodeText(records))) + end()  ≡  executeRecords(schema, records)
```

Required v0.1 test matrix:

```
 1. sequential fields                    11. array items interleaved with other fields
 2. reversed fields                      12. completion before other fields
 3. random field interleaving            13. append after completion
 4. random transport fragmentation       14. duplicate completion
 5. field split at every character       15. object completion with absent fields
 6. empty string                         16. object abort
 7. very long string                     17. codec release/reacquire
 8. surrogate pairs                      18. view retained past release
 9. maxLength boundary                   19. arena exhaustion
10. maxLength + 1                        20. multiple codecs sharing one pool
```

Items 17–20 concern pooled/arena implementations and are exercised once the
optimized receiver exists.

## 11. Extensions — explicitly not v0.1

- Nested object fields with independent child completion (paths already express
  nesting; recursion is a v2 codec concern)
- `stream`-mode fields (infinite accumulation conflicts with object framing;
  needs its own framing)
- `ITEM_COMPLETE` as a **semantic projection**, not a wire record. The wire's
  record set stays `FIELD_APPEND / FIELD_COMPLETE / OBJECT_COMPLETE /
  OBJECT_ABORT`; array item boundaries are already expressible (one
  `FIELD_APPEND` per item). The semantic layer may project item completion
  from any source (each JSON array element, each array append) so consumers
  can act on items without every producer/transport understanding the
  higher-level concept. Three event tiers: **wire events** (records arrive) →
  **semantic events** (value/item complete) → **consumer events** (application
  work released).
- Merge semantics for shared fields
- Abort reason payloads
- Session flow control / backpressure
- Schema evolution beyond append-at-end
