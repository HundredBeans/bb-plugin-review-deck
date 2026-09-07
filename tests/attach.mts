// A deck can be linked to a thread that did not create it — the thread opened
// to fix its findings, or any thread you attach it to by hand.
import assert from "node:assert/strict";
import { createFakePluginHost, makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import plugin from "../server.ts";

const spawned: { title: string }[] = [];
const { bb, harness } = createFakePluginHost({
  pluginId: "review-deck",
  sdk: {
    projects: { list: async () => [{ id: "proj_1", name: "d", gitRemoteUrl: null, sources: [] }] },
    threads: {
      get: async () => makeThreadResponse({ id: "thr_author", environmentId: "env_1" }),
      spawn: async (a: { title: string }) => {
        spawned.push({ title: a.title });
        return makeThreadResponse({ id: `thr_spawn${spawned.length}` });
      },
      send: async () => ({}),
    },
    environments: {
      get: async () => ({ hostId: "h", mergeBaseBranch: null, baseBranch: null, defaultBranch: "main" }),
      diffFiles: async () => ({ outcome: "available", files: [], initialPatches: [], mergeBaseRef: null, shortstat: "", truncated: false }),
    },
  },
});
await plugin(bb);

const ctx = { threadId: "thr_author", projectId: "proj_1" };
const deck = JSON.parse(String(await harness.behavior.callAgentTool(
  "review_deck_create", { title: "Retry failed payouts", summary: "s" }, ctx)));
await harness.behavior.callAgentTool("review_deck_add_slide", {
  deckId: deck.deckId, title: "The retry worker", summary: "…",
  annotations: [{ path: "a.ts", line: 1, title: "keeps a stale key" }],
}, ctx);
await harness.behavior.callAgentTool("review_deck_finish", { deckId: deck.deckId }, ctx);
const findingId = JSON.parse(String(await harness.behavior.callAgentTool(
  "review_deck_read", { deckId: deck.deckId }, ctx))).slides[0].findings[0].findingId;
await harness.behavior.callRpc("annotation_set_verdict", {
  deckId: deck.deckId, annotationId: findingId, verdict: "accepted", note: "",
});

// --- an unrelated thread knows nothing about it -------------------------
const before = await harness.behavior.callRpc("thread_review_status", {
  threadId: "thr_unrelated",
});
assert.equal(before.deckId, null, "an unrelated thread has no deck");
assert.equal(before.attachedAs, null);

// --- "Fix the agreed findings" attaches the deck to the thread it opens --
const fix = await harness.behavior.callRpc("deck_act", {
  deckId: deck.deckId, intent: "fix",
});
assert.equal(fix.ok, true, fix.message);
const fixThread = "thr_spawn1";
const onFix = await harness.behavior.callRpc("thread_review_status", {
  threadId: fixThread,
});
assert.equal(onFix.deckId, deck.deckId, "the fix thread shows the deck it works from");
assert.equal(onFix.attachedAs, "fix", "and knows why it is there");
assert.equal(onFix.attachedDeckTitle, "Retry failed payouts");
assert.equal(onFix.isRunner, false, "it is not a reviewer");
assert.equal(onFix.slideCount, 1);

// An agent in that thread can read the deck without being given an id.
const implicit = JSON.parse(String(await harness.behavior.callAgentTool(
  "review_deck_read", {}, { threadId: fixThread, projectId: "proj_1" })));
assert.equal(implicit.deckId, deck.deckId, "review_deck_read resolves it there");

// --- attaching by hand, and detaching -----------------------------------
await harness.behavior.callRpc("deck_attach", {
  deckId: deck.deckId, threadId: "thr_unrelated",
});
const attached = await harness.behavior.callRpc("thread_review_status", {
  threadId: "thr_unrelated",
});
assert.equal(attached.deckId, deck.deckId, "the attached deck shows up");
assert.equal(attached.attachedAs, "attached", "labelled as attached, not a review");
assert.equal(attached.canStartReview, true, "and you can still review that thread");

const off = await harness.behavior.callRpc("deck_detach", { threadId: "thr_unrelated" });
assert.equal(off.detached, true);
const gone = await harness.behavior.callRpc("thread_review_status", {
  threadId: "thr_unrelated",
});
assert.equal(gone.deckId, null, "detaching leaves the thread alone again");

// --- a thread that made its own deck is unaffected ----------------------
const author = await harness.behavior.callRpc("thread_review_status", {
  threadId: "thr_author",
});
assert.equal(author.deckId, deck.deckId, "the authoring thread still finds its deck");
assert.equal(author.attachedAs, null, "and it is not merely 'attached'");

// --- deleting the deck drops the links ----------------------------------
await harness.behavior.callRpc("deck_delete", { deckId: deck.deckId });
const orphan = await harness.behavior.callRpc("thread_review_status", {
  threadId: fixThread,
});
assert.equal(orphan.deckId, null, "no dangling link to a deleted deck");

await harness.lifecycle.dispose();
console.log("PASS — a deck can be attached to a thread that did not create it");
