// Editing a deck in place. The reviewer is looking at it, so an edit must
// change exactly what was asked and leave their answers alone.
import assert from "node:assert/strict";
import { createFakePluginHost, makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import plugin from "../server.ts";

const { bb, harness } = createFakePluginHost({
  pluginId: "review-deck",
  sdk: {
    projects: { list: async () => [{ id: "proj_1", name: "d", gitRemoteUrl: null, sources: [] }] },
    threads: {
      get: async () => makeThreadResponse({ id: "thr_author", environmentId: null }),
      spawn: async () => makeThreadResponse({ id: "thr_chat" }),
      send: async () => ({}),
    },
  },
});
await plugin(bb);

const ctx = { threadId: "thr_author", projectId: "proj_1" };
const call = (name: string, args: unknown, c = ctx) =>
  harness.behavior.callAgentTool(name, args, c);

const deck = JSON.parse(String(await call("review_deck_create", {
  title: "Retry failed payouts", summary: "adds a retry queue",
})));
for (const [title, findings] of [
  ["The contract", ["customText should be an amount", "owner is missing"]],
  ["The PUT", ["chat has no owner rule"]],
  ["Tests", []],
] as [string, string[]][]) {
  await call("review_deck_add_slide", {
    deckId: deck.deckId, title, summary: "…",
    annotations: findings.map((t, i) => ({ path: "a.ts", line: i + 10, title: t })),
  });
}
await call("review_deck_finish", { deckId: deck.deckId });

// The reviewer answers two findings and marks a slide.
const before = JSON.parse(String(await call("review_deck_read", { deckId: deck.deckId })));
assert.equal(before.slides.length, 3);
const f = (t: string) =>
  before.slides.flatMap((s: { findings: { findingId: string; title: string }[] }) => s.findings)
    .find((x: { title: string }) => x.title === t)!.findingId;
const keep = f("customText should be an amount");
const drop = f("owner is missing");
await harness.behavior.callRpc("annotation_set_verdict", {
  deckId: deck.deckId, annotationId: keep, verdict: "accepted", note: "will fix",
});
await harness.behavior.callRpc("annotation_set_verdict", {
  deckId: deck.deckId, annotationId: drop, verdict: "rejected", note: "wrong",
});
await harness.behavior.callRpc("slide_set_state", {
  deckId: deck.deckId, slideId: before.slides[0].slideId, state: "needs-work", note: "see notes",
});

// Now: "drop that finding, reword this one, fix a severity, add a slide."
const result = JSON.parse(String(await call("review_deck_edit", {
  deckId: deck.deckId,
  operations: [
    { op: "remove_finding", finding: drop },
    { op: "edit_finding", finding: keep, severity: "blocker", title: "customText must carry a unit" },
    { op: "edit_slide", slide: 2, title: "The retry PUT" },
    { op: "add_slide", after: 3, title: "Rollout", summary: "how it ships", kind: "risk" },
    { op: "move_slide", slide: "Rollout", to: 1 },
  ],
})));
assert.equal(result.applied.length, 5, JSON.stringify(result.applied));
assert.match(String(result.applied[4]), /no slide/, "a bad slide reference is reported, not silent");

const after = JSON.parse(String(await call("review_deck_read", { deckId: deck.deckId })));

// The removed finding is gone, with its mark.
const titles = after.slides.flatMap((s: { findings: { title: string }[] }) => s.findings).map((x: { title: string }) => x.title);
assert.ok(!titles.includes("owner is missing"), "the finding is gone");

// The edited finding kept its id, so the reviewer's answer is still on it.
const edited = after.slides[0].findings.find((x: { findingId: string }) => x.findingId === keep);
assert.ok(edited, "the finding kept its id");
assert.equal(edited.title, "customText must carry a unit", "and took the new wording");
assert.equal(edited.severity, "blocker", "and the new severity");
assert.equal(edited.reviewerVerdict, "accepted", "and the reviewer still agrees with it");
assert.equal(edited.reviewerNote, "will fix");

// The slide rename kept the reviewer's mark on that slide.
assert.equal(after.slides[1].title, "The retry PUT", "the slide was renamed");
assert.equal(after.slides[0].reviewerVerdict, "needs-work", "slide mark survived");
assert.equal(after.slides[0].reviewerNote, "see notes");

// The new slide landed and positions are contiguous.
assert.equal(after.slides.length, 4, "a slide was added");
assert.ok(after.slides.some((s: { title: string }) => s.title === "Rollout"));
assert.deepEqual(
  after.slides.map((s: { position: number }) => s.position),
  [1, 2, 3, 4],
  "positions stay 1..n with no gaps",
);

// A removed slide takes its findings and renumbers the rest.
await call("review_deck_edit", {
  deckId: deck.deckId,
  operations: [{ op: "remove_slide", slide: "Rollout" }],
});
const trimmed = JSON.parse(String(await call("review_deck_read", { deckId: deck.deckId })));
assert.equal(trimmed.slides.length, 4, "an unknown slide name removes nothing");

const byId = trimmed.slides.find((s: { title: string }) => s.title === "Rollout")!.slideId;
await call("review_deck_edit", {
  deckId: deck.deckId,
  operations: [{ op: "remove_slide", slide: byId }],
});
const final = JSON.parse(String(await call("review_deck_read", { deckId: deck.deckId })));
assert.equal(final.slides.length, 3, "removed by id");
assert.deepEqual(final.slides.map((s: { position: number }) => s.position), [1, 2, 3]);

// And the deck this thread is about is found without an id.
const implicit = JSON.parse(String(await call("review_deck_read", {})));
assert.equal(implicit.deckId, deck.deckId, "no deckId needed inside the deck's thread");

await harness.lifecycle.dispose();
console.log("PASS — a deck can be edited in place without losing your answers");
