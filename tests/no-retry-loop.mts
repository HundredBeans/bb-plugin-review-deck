// A stopped review must not be retried on every sweep.
//
// This is the bug that spawned an agent run every five minutes for an hour.
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
assert.equal(spawned.length, 1, "adding the watch starts one review");

/** Stop the current run without the agent ever finishing its deck. */
const stopCurrentRun = async () => {
  await harness.behavior.emitThreadEvent("thread.idle", {
    thread: makeThreadResponse({ id: spawned[spawned.length - 1]! }),
    lastAssistantText: null,
  });
  await new Promise((r) => setTimeout(r, 40));
};

await stopCurrentRun();

// Three sweeps over the same unchanged commit.
for (let sweep = 0; sweep < 3; sweep += 1) {
  await harness.behavior.runCli(["poll"]);
  await new Promise((r) => setTimeout(r, 20));
}
assert.equal(
  spawned.length,
  1,
  `the sweep must not retry a commit that already failed (spawned ${spawned.length})`,
);

// Asking for it by hand is still allowed.
const watchId = (
  (await harness.behavior.callRpc("watches_list", null)).watches as { id: string }[]
)[0]!.id;
const manual = await harness.behavior.callRpc("watch_run_now", { watchId });
assert.equal(manual.started, true, "Review now still works");
assert.equal(spawned.length, 2, "and it really does start one");

// Repeated failures stand the watch down entirely.
await stopCurrentRun();
await harness.behavior.callRpc("watch_run_now", { watchId });
await stopCurrentRun();
const [watch] = (await harness.behavior.callRpc("watches_list", null)).watches as {
  enabled: boolean;
  lastError: string | null;
}[];
assert.equal(watch!.enabled, false, "three failures in a row pauses the watch");
assert.match(String(watch!.lastError), /Paused after 3 attempts/);

await harness.lifecycle.dispose();
console.log("PASS — a failed review is not retried every sweep");
