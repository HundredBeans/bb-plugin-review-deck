// Drives the plugin against the SDK's fake host to prove that a re-review
// keeps the reviewer's marks and drops the ones whose finding is gone.
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

// A real merge request, read through the user's own glab login.
const add = await harness.behavior.runCli([
  "watch",
  "https://gitlab.example.com/acme/widgets/-/merge_requests/142",
]);
assert.equal(add.exitCode, 0, add.stderr);
assert.equal(spawned.length, 1, "adding a watch should start one review");

const threadId = spawned[0]!;
const callTool = (name: string, args: unknown) =>
  harness.behavior.callAgentTool(name, args, { threadId, projectId: "proj_1" });

async function review(findings: { path: string; title: string }[]) {
  const created = JSON.parse(String((await callTool("review_deck_create", {
    title: "Retry failed payouts",
    summary: "first pass",
    target: { target: "all", mergeBaseBranch: "origin/main" },
  })) as string));
  await callTool("review_deck_add_slide", {
    deckId: created.deckId,
    title: "The retry worker",
    summary: "shape changes",
    files: [{ path: "src/config.ts", patch: "@@ -1,2 +1,3 @@\n a\n+b\n c\n" }],
    annotations: findings.map((f) => ({
      path: f.path,
      line: 2,
      title: f.title,
      body: "why it matters",
    })),
  });
  await callTool("review_deck_finish", { deckId: created.deckId });
  return created.deckId as string;
}

// First review: two findings; the reviewer answers both.
const deckId = await review([
  { path: "src/config.ts", title: "Nested block is not migrated" },
  { path: "src/config.ts", title: "Missing test for the flag" },
]);
const first = JSON.parse(JSON.stringify((await harness.behavior.callRpc("deck_get", { deckId })).deck));
const [a1, a2] = first.slides[0].annotations.map((a: { id: string }) => a.id);
await harness.behavior.callRpc("annotation_set_verdict", {
  deckId, annotationId: a1, verdict: "accepted", note: "will fix",
});
await harness.behavior.callRpc("annotation_set_verdict", {
  deckId, annotationId: a2, verdict: "rejected", note: "covered elsewhere",
});
await harness.behavior.callRpc("slide_set_state", {
  deckId, slideId: first.slides[0].id, state: "needs-work", note: "see above",
});

// Second review after a push: one finding survives, one is fixed, one is new.
const deckId2 = await review([
  { path: "src/config.ts", title: "Nested block is not migrated" },
  { path: "src/config.ts", title: "New: default is wrong" },
]);
assert.equal(deckId2, deckId, "the deck link must stay the same");

const second = JSON.parse(JSON.stringify((await harness.behavior.callRpc("deck_get", { deckId })).deck));
const slide = second.slides[0];
const byTitle = new Map(slide.annotations.map((a: { id: string; title: string }) => [a.title, a.id]));

const kept = second.verdicts[byTitle.get("Nested block is not migrated") as string];
assert.deepEqual(
  { verdict: kept?.verdict, note: kept?.note },
  { verdict: "accepted", note: "will fix" },
  "a finding that is still there keeps its mark",
);
assert.equal(
  second.verdicts[byTitle.get("New: default is wrong") as string],
  undefined,
  "a new finding arrives unmarked",
);
assert.equal(
  Object.keys(second.verdicts).length,
  1,
  "the mark on the fixed finding is dropped",
);
assert.equal(slide.state, "needs-work", "the slide's own mark survives");
assert.equal(slide.note, "see above");

// Two "Review now" presses at once must not put two agents on one deck.
const listed = await harness.behavior.callRpc("watches_list", null);
const watchId = (listed.watches as { id: string }[])[0]!.id;

// While a run holds the slot, nothing else may start one.
const held = spawned.length;
const busy = await Promise.all([
  harness.behavior.callRpc("watch_run_now", { watchId }),
  harness.behavior.callRpc("watch_run_now", { watchId }),
]);
assert.deepEqual(
  busy.map((r) => r.started),
  [false, false],
  "a review already in flight blocks new ones",
);
assert.equal(spawned.length, held, "and spawns nothing");

// Release the slot the way the real host does, then race two requests.
await harness.behavior.emitThreadEvent("thread.idle", {
  thread: makeThreadResponse({ id: threadId }),
  lastAssistantText: null,
});
await new Promise((resolve) => setTimeout(resolve, 50));

const before = spawned.length;
const [runA, runB] = await Promise.all([
  harness.behavior.callRpc("watch_run_now", { watchId }),
  harness.behavior.callRpc("watch_run_now", { watchId }),
]);
assert.equal(
  spawned.length - before,
  1,
  "two concurrent runs must spawn exactly one review thread",
);
assert.equal(
  [runA.started, runB.started].filter(Boolean).length,
  1,
  "exactly one of the two calls should report that it started",
);

await harness.lifecycle.dispose();
console.log("PASS — marks carry across a re-review, and stale ones are dropped");
console.log("PASS — concurrent review requests spawn only one agent");
