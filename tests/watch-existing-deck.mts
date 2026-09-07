// Pointing a merge request at a deck that already exists.
//
// The deck IS the review of the current commit, so linking must not kick off
// another one — only the next push should.
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
process.env.BB_REVIEW_DECK_GLAB = fileURLToPath(
  new URL("./fixtures/fake-glab.mjs", import.meta.url),
);
import { createFakePluginHost, makeThreadResponse } from "@get-bb/plugin-sdk/testing";
const plugin = (await import("../server.ts")).default;

const spawned: string[] = [];
const { bb, harness } = createFakePluginHost({
  pluginId: "review-deck",
  sdk: {
    projects: {
      list: async () => [
        {
          id: "proj_1",
          name: "widgets",
          gitRemoteUrl: "git@gitlab.example.com:acme/widgets.git",
          sources: [{ id: "src_1", hostId: "host_1", isDefault: true }],
        },
      ],
    },
    threads: {
      get: async () => makeThreadResponse({ id: "thr_work", environmentId: null }),
      spawn: async () => {
        spawned.push(`thr_run${spawned.length + 1}`);
        return makeThreadResponse({ id: spawned[spawned.length - 1]! });
      },
      archive: async () => ({}),
      stop: async () => ({}),
    },
    environments: { get: async () => ({ hostId: "host_1" }) },
  },
});
await plugin(bb);

const MR = "https://gitlab.example.com/acme/widgets/-/merge_requests/142";
const ctx = { threadId: "thr_work", projectId: "proj_1" };

// A review published from a conversation: no merge request recorded.
const deck = JSON.parse(String(await harness.behavior.callAgentTool(
  "review_deck_create", { title: "Retype the user service", summary: "" }, ctx)));
await harness.behavior.callAgentTool("review_deck_add_slide", {
  deckId: deck.deckId, title: "The client", summary: "…",
}, ctx);
await harness.behavior.callAgentTool("review_deck_finish", { deckId: deck.deckId }, ctx);

const before = await harness.behavior.callRpc("deck_next_actions", { deckId: deck.deckId });
assert.equal(before.canPostToMr, false, "no merge request, so nothing keeps it current");

// Link it. This must not start a review.
const linked = await harness.behavior.callRpc("deck_watch_mr", {
  deckId: deck.deckId, url: MR,
});
assert.equal(linked.ok, true, linked.message);
assert.equal(spawned.length, 0, "linking must not kick off a review — the deck is the review");
assert.match(String(linked.message), /up to date now/i);

const after = await harness.behavior.callRpc("deck_next_actions", { deckId: deck.deckId });
assert.equal(after.canPostToMr, true, "now it can post to the merge request");
assert.equal(after.mrLabel, "!142");

// A sweep at the same commit leaves it alone.
await harness.behavior.runCli(["poll"]);
assert.equal(spawned.length, 0, "the reviewed commit is not reviewed again");

// A push moves the head, and then it does re-review — into the same deck.
process.env.FAKE_MR_SHA = "bbbbbbbbbbbb";
await harness.behavior.runCli(["poll"]);
assert.equal(spawned.length, 1, "a new commit triggers exactly one review");
const [watch] = (await harness.behavior.callRpc("watches_list", null)).watches as {
  deckId: string | null;
}[];
assert.equal(watch!.deckId, deck.deckId, "and it rewrites the deck you already had");

// Linking the same merge request to a second deck is refused, not silently
// stolen from the first.
const other = JSON.parse(String(await harness.behavior.callAgentTool(
  "review_deck_create", { title: "Another deck", summary: "" }, ctx)));
const clash = await harness.behavior.callRpc("deck_watch_mr", {
  deckId: other.deckId, url: MR,
});
assert.equal(clash.ok, false, "refused");
assert.match(String(clash.message), /already watched/i);

// A bad link is reported rather than half-applied.
const bad = await harness.behavior.callRpc("deck_watch_mr", {
  deckId: other.deckId, url: "https://gitlab.example.com/acme/widgets/-/issues/3",
});
assert.equal(bad.ok, false);
assert.match(String(bad.message), /not a merge request link/i);

delete process.env.FAKE_MR_SHA;
await harness.lifecycle.dispose();
console.log("PASS — a deck can be kept current without being re-reviewed first");
