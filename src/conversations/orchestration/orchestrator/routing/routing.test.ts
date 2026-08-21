import { describe, expect, test } from "bun:test";
import { Agent } from "../../../../agents/agent";
import {
  buildUnderstandPrompt,
  findAddressedAgent,
  findAgentByName,
  pickAgent,
} from "./routing";

describe("pickAgent", () => {
  const receptionist = new Agent({ name: "Receptionist" });
  const specialist = new Agent({
    name: "Technical Specialist",
    aliases: ["tech", "support"],
  });
  const roster = [receptionist, specialist];

  test("matches by name, then alias, then defaults to the first agent", () => {
    expect(pickAgent(roster, "ask the technical specialist about X")).toBe(
      specialist,
    );
    expect(pickAgent(roster, "talk to tech please")).toBe(specialist);
    expect(pickAgent(roster, "hi there")).toBe(receptionist);
    expect(pickAgent(roster, "")).toBe(receptionist);
  });

  test("matching is case-insensitive", () => {
    expect(pickAgent(roster, "TECHNICAL SPECIALIST!")).toBe(specialist);
    expect(pickAgent(roster, "Hi, Tech")).toBe(specialist);
    expect(pickAgent(roster, "RECEPTIONIST?")).toBe(receptionist);
  });

  test("returns null for an empty roster", () => {
    expect(pickAgent([], "anything")).toBeNull();
  });
});

describe("findAddressedAgent", () => {
  test("returns the addressed agent without defaulting", () => {
    const receptionist = new Agent({ name: "Receptionist" });
    const specialist = new Agent({ name: "Technical Specialist", aliases: ["tech"] });
    const roster = [receptionist, specialist];
    expect(findAddressedAgent(roster, "ask tech please")).toBe(specialist);
    expect(findAddressedAgent(roster, "Technical Specialist!")).toBe(specialist);
    expect(findAddressedAgent(roster, "hello there")).toBeNull();
  });
});

describe("findAgentByName", () => {
  test("matches exact name or alias, case-insensitively", () => {
    const travel = new Agent({ name: "Travel Agent", aliases: ["travel"] });
    const calendar = new Agent({ name: "Calendar Agent" });
    expect(findAgentByName([travel, calendar], "travel")).toBe(travel);
    expect(findAgentByName([travel, calendar], "TRAVEL AGENT")).toBe(travel);
    expect(findAgentByName([travel, calendar], "  travel ")).toBe(travel);
    expect(findAgentByName([travel, calendar], "calendar agent")).toBe(calendar);
    expect(findAgentByName([travel, calendar], "calendar")).toBeNull();
  });
});

describe("buildUnderstandPrompt", () => {
  test("lists the roster with aliases", () => {
    const prompt = buildUnderstandPrompt([
      new Agent({ name: "Travel", aliases: ["trip"] }),
      new Agent({ name: "Calendar" }),
    ]);
    expect(prompt).toContain("- Travel (aliases: trip)");
    expect(prompt).toContain("- Calendar");
    expect(prompt).toContain("delegate");
  });
});
