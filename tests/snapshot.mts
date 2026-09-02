// A merge-request review runs in a worktree that is retired when the run ends.
// The deck must still show its code afterwards.
import assert from "node:assert/strict";
import { createFakePluginHost, makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import plugin from "../server.ts";

const PATCH = "@@ -1,3 +1,4 @@\n context\n-old line\n+new line\n+added line\n";
let workspaceAlive = true;

const { bb, harness } = createFakePluginHost({
  pluginId: "review-deck",
  sdk: {
    threads: {
      get: async () =>
        makeThreadResponse({ id: "thr_1", environmentId: "env_worktree" }),
    },
    environments: {
      get: async () => ({
        hostId: "host_1",
        mergeBaseBranch: null,
        baseBranch: "origin/main",
        defaultBranch: "main",
      }),
      diffFiles: async () => ({
        outcome: "available",
        files: [],
        initialPatches: [],
        mergeBaseRef: null,
        shortstat: "1 file changed",
        truncated: false,
      }),
      diffPatch: async () => {
        if (!workspaceAlive) throw new Error("HTTP 409: Environment unavailable");
        return {
          outcome: "available",
          patches: [{ path: "src/config.ts", patch: PATCH, truncated: false }],
        };
      },
    },
  },
});
await plugin(bb);

const ctx = { threadId: "thr_1", projectId: "proj_1" };
const created = JSON.parse(
  String(await harness.behavior.callAgentTool("review_deck_create", {
    title: "Retry failed payouts",
    summary: "adds a retry queue",
    target: { target: "all", mergeBaseBranch: "origin/main" },
  }, ctx)),
);
const slide = JSON.parse(
  String(await harness.behavior.callAgentTool("review_deck_add_slide", {
    deckId: created.deckId,
    title: "The retry worker",
    summary: "shape changes",
    files: [{ path: "src/config.ts" }],
    annotations: [{ path: "src/config.ts", line: 3, title: "Owner is missing" }],
  }, ctx)),
);

// While the worktree is alive the deck reads the live diff.
const live = await harness.behavior.callRpc("slide_patches", {
  deckId: created.deckId,
  slideId: slide.slideId,
});
assert.equal(live.patches[0].source, "environment");
assert.equal(live.patches[0].patch, PATCH);

// Finishing copies the diff into the deck.
await harness.behavior.callAgentTool("review_deck_finish", { deckId: created.deckId }, ctx);

// The worker thread is archived and the worktree is retired.
workspaceAlive = false;

const after = await harness.behavior.callRpc("slide_patches", {
  deckId: created.deckId,
  slideId: slide.slideId,
});
assert.equal(after.patches[0].source, "snapshot", "falls back to the stored copy");
assert.equal(after.patches[0].patch, PATCH, "and it is the same diff");
assert.equal(after.patches[0].error, null, "with no error shown to the reviewer");

await harness.lifecycle.dispose();
console.log("PASS — a deck still shows its code after the worktree is gone");
