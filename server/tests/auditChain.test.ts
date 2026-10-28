import crypto from "crypto";
import { Types } from "mongoose";
import { canonicalJson, computeEventHash, GENESIS_HASH } from "../src/services/audit/audit.service";

// The hash chain's building blocks, as pure functions (no database).

const workspaceId = new Types.ObjectId();
const event = {
  workspaceId,
  seq: 4,
  type: "action_executed" as const,
  actionId: new Types.ObjectId(),
  actor: { type: "system" as const, id: "system", name: "AgentGuard" },
  onBehalfOf: "Ravi (support team)",
  summary: "Done: Cancel booking BK-1002",
  createdAt: new Date("2026-10-28T10:15:30.123Z"),
};

describe("canonicalJson", () => {
  it("gives the same text whatever order the keys were written in", () => {
    expect(canonicalJson({ b: 1, a: { d: [3, { y: 1, x: 2 }], c: "x" } })).toBe(canonicalJson({ a: { c: "x", d: [3, { x: 2, y: 1 }] }, b: 1 }));
  });

  it("is plain sorted JSON, leaves out undefined, and keeps null", () => {
    expect(canonicalJson({ z: undefined, b: null, a: "é\"" })).toBe('{"a":"é\\"","b":null}');
    expect(canonicalJson([1, "a", true])).toBe('[1,"a",true]');
  });
});

describe("computeEventHash", () => {
  it("is SHA-256 of the previous hash followed by the event's canonical JSON", () => {
    const expected = crypto
      .createHash("sha256")
      .update(
        GENESIS_HASH +
          canonicalJson({
            workspaceId: String(workspaceId),
            seq: 4,
            type: "action_executed",
            actionId: String(event.actionId),
            policyId: null,
            actor: { type: "system", id: "system", name: "AgentGuard" },
            onBehalfOf: "Ravi (support team)",
            summary: "Done: Cancel booking BK-1002",
            createdAt: "2026-10-28T10:15:30.123Z",
          })
      )
      .digest("hex");
    expect(computeEventHash(GENESIS_HASH, event)).toBe(expected);
  });

  it("changes when anything in the event changes, or when the previous hash does", () => {
    const base = computeEventHash(GENESIS_HASH, event);
    const changes = [
      { ...event, summary: "Done: Cancel booking BK-1003" },
      { ...event, seq: 5 },
      { ...event, type: "action_failed" as const },
      { ...event, onBehalfOf: "someone else" },
      { ...event, actor: { ...event.actor, name: "Someone" } },
      { ...event, actionId: new Types.ObjectId() },
      { ...event, workspaceId: new Types.ObjectId() },
      { ...event, createdAt: new Date("2026-10-28T10:15:30.124Z") },
    ];
    for (const changed of changes) expect(computeEventHash(GENESIS_HASH, changed)).not.toBe(base);
    expect(computeEventHash("a".repeat(64), event)).not.toBe(base);
  });

  it("treats a missing onBehalfOf and an empty one the same (the database stores an empty one)", () => {
    expect(computeEventHash(GENESIS_HASH, { ...event, onBehalfOf: undefined })).toBe(computeEventHash(GENESIS_HASH, { ...event, onBehalfOf: "" }));
  });
});
