// Stopping a review must not record the merge request as reviewed.
import assert from "node:assert/strict";
import { createFakePluginHost, makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import { fileURLToPath } from "node:url";

// Offline: the plugin reads merge requests through this stub, not real glab.
process.env.BB_REVIEW_DECK_GLAB = fileURLToPath(
  new URL("./fixtures/fake-glab.mjs", import.meta.url),
);

const plugin = (await import("../server.ts")).default;

const spawned: string[] = [];
const { bb, harness } = createFakePluginHost({
  pluginId: "review-deck",
  sdk: {
    projects: {
      list: async () => [
        {
          id: "proj_1",
          name: "demo",
          gitRemoteUrl: "git@gitlab.example.com:acme/widgets.git",
          sources: [{ id: "src_1", hostId: "host_1", isDefault: true }],
        },
      ],
    },
    threads: {
      spawn: async () => {
        const id = `thr_run${spawned.length + 1}`;
        spawned.push(id);
        return makeThreadResponse({ id });
      },
      get: async () => makeThreadResponse({ id: "thr_run1", environmentId: null }),
      archive: async () => ({}),
      stop: async () => ({}),
    },
    environments: { get: async () => ({ hostId: "host_1" }) },
  },
});
await plugin(bb);

const add = await harness.behavior.runCli([
  "watch",
  "https://gitlab.example.com/acme/widgets/-/merge_requests/142",
]);
assert.equal(add.exitCode, 0, add.stderr);
const watchId = (
  (await harness.behavior.callRpc("watches_list", null)).watches as { id: string }[]
)[0]!.id;
const ctx = { threadId: spawned[0]!, projectId: "proj_1" };

// The agent starts a deck and writes one slide, then the run is stopped.
const deck = JSON.parse(String(await harness.behavior.callAgentTool(
  "review_deck_create", { title: "Half a review", summary: "" }, ctx)));
await harness.behavior.callAgentTool("review_deck_add_slide", {
  deckId: deck.deckId, title: "Only slide", summary: "…",
}, ctx);
// No review_deck_finish — this is what stopping looks like.
await harness.behavior.emitThreadEvent("thread.idle", {
  thread: makeThreadResponse({ id: spawned[0]! }), lastAssistantText: null,
});
await new Promise((r) => setTimeout(r, 40));

const [watch] = (await harness.behavior.callRpc("watches_list", null))
  .watches as { state: string; lastSha: string | null; lastReviewedAt: string | null; lastError: string | null }[];
assert.equal(watch!.lastSha, null, "a stopped review does not record the commit");
assert.equal(watch!.lastReviewedAt, null, "and does not count as reviewed");
assert.equal(watch!.state, "error", "the watch says something went wrong");
assert.match(String(watch!.lastError), /stopped/i, "and says what");

// Because the commit was never recorded, running again is still possible.
const again = await harness.behavior.callRpc("watch_run_now", { watchId });
assert.equal(again.started, true, "the merge request can be reviewed again");

await harness.lifecycle.dispose();
console.log("PASS — a stopped review is not recorded as reviewed");
