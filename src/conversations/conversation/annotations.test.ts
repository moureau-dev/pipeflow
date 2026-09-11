import { describe, expect, test } from "bun:test";
import { Annotations } from "./annotations";

describe("Annotations", () => {
  test("starts empty", () => {
    const a = new Annotations();
    expect(a.size).toBe(0);
    expect(a.entries.size).toBe(0);
  });

  test("set single key-value", () => {
    const a = new Annotations();
    a.set("file", "src/app.ts");
    expect(a.size).toBe(1);
    expect(a.entries.get("file")).toBe("src/app.ts");
  });

  test("set multiple entries at once", () => {
    const a = new Annotations();
    a.set({ role: "admin", mode: "review" });
    expect(a.size).toBe(2);
    expect(a.entries.get("role")).toBe("admin");
    expect(a.entries.get("mode")).toBe("review");
  });

  test("set overwrites existing key", () => {
    const a = new Annotations();
    a.set("file", "old.ts");
    a.set("file", "new.ts");
    expect(a.entries.get("file")).toBe("new.ts");
    expect(a.size).toBe(1);
  });

  test("delete removes a key", () => {
    const a = new Annotations();
    a.set("file", "src/app.ts");
    a.delete("file");
    expect(a.size).toBe(0);
    expect(a.entries.has("file")).toBe(false);
  });

  test("delete on missing key is a no-op", () => {
    const a = new Annotations();
    a.delete("nonexistent");
    expect(a.size).toBe(0);
  });

  test("clear removes all entries", () => {
    const a = new Annotations();
    a.set({ a: "1", b: "2", c: "3" });
    a.clear();
    expect(a.size).toBe(0);
  });

  test("entries is a live view", () => {
    const a = new Annotations();
    const view = a.entries;
    a.set("key", "value");
    expect(view.get("key")).toBe("value");
    a.delete("key");
    expect(view.has("key")).toBe(false);
  });
});