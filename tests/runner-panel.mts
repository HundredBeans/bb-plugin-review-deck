// The panel beside a reviewer must show the review, not offer a new one —
// including during the minutes before the agent has written any slides.
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
      get: async () => makeThreadResponse({ id: "thr_x", environmentId: null }),
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
const runner = spawned[0]!;

// The reviewer has spawned and is reading. No deck exists yet.
const early = await harness.behavior.callRpc("thread_review_status", {
  threadId: runner,
});
assert.equal(early.isRunner, true, "recognised as the reviewer straight away");
assert.equal(early.running, true, "and shown as running");
assert.equal(early.deckId, null, "with no deck yet");
assert.equal(
  early.canStartReview,
  false,
  "so it must not offer to start another review",
);
assert.match(String(early.reviewing), /!142/, "and says what it is reviewing");

// Now it writes the deck.
const ctx = { threadId: runner, projectId: "proj_1" };
const deck = JSON.parse(String(await harness.behavior.callAgentTool(
  "review_deck_create", { title: "Retry failed payouts", summary: "" }, ctx)));
await harness.behavior.callAgentTool("review_deck_add_slide", {
  deckId: deck.deckId, title: "The retry worker", summary: "…",
}, ctx);

const mid = await harness.behavior.callRpc("thread_review_status", { threadId: runner });
assert.equal(mid.deckId, deck.deckId, "the panel picks the deck up");
assert.equal(mid.slideCount, 1, "and counts slides as they land");
assert.equal(mid.isRunner, true);

// And after the run ends the panel still shows that deck.
await harness.behavior.callAgentTool("review_deck_finish", { deckId: deck.deckId }, ctx);
await harness.behavior.emitThreadEvent("thread.idle", {
  thread: makeThreadResponse({ id: runner }),
  lastAssistantText: null,
});
await new Promise((r) => setTimeout(r, 40));

const done = await harness.behavior.callRpc("thread_review_status", { threadId: runner });
assert.equal(done.isRunner, true, "still the reviewer after it finishes");
assert.equal(done.running, false, "no longer running");
assert.equal(done.deckId, deck.deckId, "and still shows its deck");

await harness.lifecycle.dispose();
console.log("PASS — a reviewer thread shows its review, deck or not");
