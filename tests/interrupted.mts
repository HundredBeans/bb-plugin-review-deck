// A re-review that dies half way through must not destroy the deck you had.
import assert from "node:assert/strict";
import { createFakePluginHost, makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import plugin from "../server.ts";

const spawned: string[] = [];
const { bb, harness } = createFakePluginHost({
  pluginId: "review-deck",
  sdk: {
    threads: {
      get: async () => makeThreadResponse({ id: "thr_source", environmentId: "env_1" }),
      spawn: async () => {
        const id = `thr_run${spawned.length + 1}`;
        spawned.push(id);
        return makeThreadResponse({ id });
      },
      stop: async () => ({}),
      archive: async () => ({}),
    },
    environments: {
      get: async () => ({ hostId: "host_1", mergeBaseBranch: null, baseBranch: null, defaultBranch: "main" }),
      diffFiles: async () => ({
        outcome: "available", files: [], initialPatches: [],
        mergeBaseRef: null, shortstat: "", truncated: false,
      }),
      diffPatch: async () => ({ outcome: "available", patches: [] }),
    },
  },
});
await plugin(bb);

// A first, complete review of a thread's changes.
const first = await harness.behavior.callRpc("thread_review_start", { threadId: "thr_source" });
assert.equal(first.started, true, first.message);
const runOne = spawned[0]!;
const ctxOne = { threadId: runOne, projectId: "proj_1" };
const deck = JSON.parse(String(await harness.behavior.callAgentTool(
  "review_deck_create", { title: "First pass", summary: "all good" }, ctxOne)));
for (const title of ["Slide one", "Slide two", "Slide three"]) {
  await harness.behavior.callAgentTool("review_deck_add_slide", {
    deckId: deck.deckId, title, summary: "…",
  }, ctxOne);
}
await harness.behavior.callAgentTool("review_deck_finish", { deckId: deck.deckId }, ctxOne);
await harness.behavior.emitThreadEvent("thread.idle", {
  thread: makeThreadResponse({ id: runOne }), lastAssistantText: null,
});
await new Promise((r) => setTimeout(r, 30));

const before = (await harness.behavior.callRpc("deck_get", { deckId: deck.deckId })).deck;
assert.equal(before.slides.length, 3);
assert.equal(before.status, "ready");

// A second review starts, rewrites one slide, then its thread dies.
const second = await harness.behavior.callRpc("thread_review_start", { threadId: "thr_source" });
assert.equal(second.started, true, second.message);
const runTwo = spawned[1]!;
const ctxTwo = { threadId: runTwo, projectId: "proj_1" };
const again = JSON.parse(String(await harness.behavior.callAgentTool(
  "review_deck_create", { title: "Second pass", summary: "partial" }, ctxTwo)));
assert.equal(again.deckId, deck.deckId, "the rewrite reuses the same deck");
await harness.behavior.callAgentTool("review_deck_add_slide", {
  deckId: deck.deckId, title: "Only slide written", summary: "…",
}, ctxTwo);

const midway = (await harness.behavior.callRpc("deck_get", { deckId: deck.deckId })).deck;
assert.equal(midway.slides.length, 1, "mid-rewrite the deck really is incomplete");

// The run dies without ever calling review_deck_finish.
await harness.behavior.emitThreadEvent("thread.failed", {
  thread: makeThreadResponse({ id: runTwo }), error: "interrupted",
});
await new Promise((r) => setTimeout(r, 30));

const after = (await harness.behavior.callRpc("deck_get", { deckId: deck.deckId })).deck;
assert.equal(after.slides.length, 3, "the deck you had is back");
assert.deepEqual(
  after.slides.map((s: { title: string }) => s.title),
  ["Slide one", "Slide two", "Slide three"],
);
assert.equal(after.status, "ready", "and it is readable again, not a draft");

await harness.lifecycle.dispose();
console.log("PASS — an interrupted re-review restores the previous deck");
