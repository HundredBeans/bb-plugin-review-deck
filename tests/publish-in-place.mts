// Turning a review that already happened into a deck, without redoing it.
import assert from "node:assert/strict";
import { createFakePluginHost, makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import plugin from "../server.ts";

const spawned: string[] = [];
const sends: { threadId: string; text: string }[] = [];
const { bb, harness } = createFakePluginHost({
  pluginId: "review-deck",
  sdk: {
    projects: { list: async () => [{ id: "proj_1", name: "d", gitRemoteUrl: null, sources: [] }] },
    threads: {
      get: async () => makeThreadResponse({ id: "thr_review", environmentId: "env_1" }),
      spawn: async () => {
        spawned.push(`thr_spawn${spawned.length + 1}`);
        return makeThreadResponse({ id: spawned[spawned.length - 1]! });
      },
      send: async (a: { threadId: string; input: { text: string }[] }) => {
        sends.push({ threadId: a.threadId, text: a.input[0]!.text });
        return {};
      },
    },
    environments: {
      get: async () => ({ hostId: "h", mergeBaseBranch: null, baseBranch: null, defaultBranch: "main" }),
      diffFiles: async () => ({ outcome: "available", files: [], initialPatches: [], mergeBaseRef: null, shortstat: "", truncated: false }),
    },
  },
});
await plugin(bb);

// A thread where a review has already happened, with no deck yet.
const before = await harness.behavior.callRpc("thread_review_status", {
  threadId: "thr_review",
});
assert.equal(before.deckId, null, "no deck yet");

const asked = await harness.behavior.callRpc("thread_publish_review", {
  threadId: "thr_review",
});
assert.equal(asked.ok, true, asked.message);
assert.equal(spawned.length, 0, "no second agent is spawned — that is the point");
assert.equal(sends.length, 1, "it speaks to the thread that did the review");
assert.equal(sends[0]!.threadId, "thr_review");

const said = sends[0]!.text;
assert.ok(/already done/i.test(said), "names the review it already did");
assert.ok(/[Dd]o not review anything again/.test(said), "tells it not to redo the work");
assert.ok(/re-read the whole diff/i.test(said), "and not to re-read the diff");
assert.ok(/review_deck_create/.test(said), "points at the tools");
assert.ok(
  /have not actually reviewed/i.test(said),
  "and guards against inventing a deck from nothing",
);

// Once a deck exists, the fast path refuses rather than making a second one.
const ctx = { threadId: "thr_review", projectId: "proj_1" };
const deck = JSON.parse(String(await harness.behavior.callAgentTool(
  "review_deck_create", { title: "Retry failed payouts", summary: "" }, ctx)));
await harness.behavior.callAgentTool("review_deck_add_slide", {
  deckId: deck.deckId, title: "The retry worker", summary: "…",
}, ctx);

const again = await harness.behavior.callRpc("thread_publish_review", {
  threadId: "thr_review",
});
assert.equal(again.ok, false, "refuses when the thread already has a deck");
assert.match(String(again.message), /already has a deck/i);
assert.equal(sends.length, 1, "and says nothing further to the thread");

await harness.lifecycle.dispose();
console.log("PASS — an existing review becomes a deck without being redone");
