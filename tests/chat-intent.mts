// Opening the chat mid-deck must not read as "I have finished reviewing".
import assert from "node:assert/strict";
import { createFakePluginHost, makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import plugin from "../server.ts";

const spawns: { prompt: string; title: string }[] = [];
// Which threads are archived, so a chat has nowhere existing to land.
const archived = new Set<string>();
const sends: string[] = [];
const { bb, harness } = createFakePluginHost({
  pluginId: "review-deck",
  sdk: {
    projects: { list: async () => [{ id: "proj_1", name: "demo", gitRemoteUrl: null, sources: [] }] },
    threads: {
      get: async ({ threadId }: { threadId: string }) =>
        makeThreadResponse({
          id: threadId,
          environmentId: "env_1",
          ...(archived.has(threadId) ? { archivedAt: 1 } : {}),
        }),
      spawn: async (args: { prompt: string; title: string }) => {
        spawns.push({ prompt: args.prompt, title: args.title });
        return makeThreadResponse({ id: `thr_chat${spawns.length}` });
      },
      send: async (args: { input: { text: string }[] }) => {
        sends.push(args.input[0]!.text);
        return {};
      },
    },
    environments: {
      get: async () => ({ hostId: "host_1", mergeBaseBranch: null, baseBranch: null, defaultBranch: "main" }),
      diffFiles: async () => ({ outcome: "available", files: [], initialPatches: [], mergeBaseRef: null, shortstat: "", truncated: false }),
    },
  },
});
await plugin(bb);

const ctx = { threadId: "thr_author", projectId: "proj_1" };
const deck = JSON.parse(String(await harness.behavior.callAgentTool(
  "review_deck_create", { title: "Measure the caller type", summary: "adds a metric and an eval" }, ctx)));
for (const title of ["The metric", "The eval", "Tests"]) {
  await harness.behavior.callAgentTool("review_deck_add_slide", {
    deckId: deck.deckId, title, summary: "…",
    annotations: [{ path: "a.ts", line: 1, title: `finding in ${title}` }],
  }, ctx);
}
await harness.behavior.callAgentTool("review_deck_finish", { deckId: deck.deckId }, ctx);

// --- pressing Chat while still reading ----------------------------------
// The authoring thread is gone, so this is the case where a chat has to be
// opened — which is what this test is about. When that thread is still alive
// the chat lands there instead; tests/chat-target.mts covers that.
archived.add("thr_author");

const ask = await harness.behavior.callRpc("deck_act", { deckId: deck.deckId, intent: "ask" });
assert.equal(ask.ok, true, ask.message);
assert.equal(spawns.length, 1, "one chat thread");
const opening = spawns[0]!.prompt;

assert.ok(
  !/has finished|have finished the/i.test(opening),
  "must not claim the review is finished",
);
assert.ok(
  /not finished reviewing/i.test(opening),
  "says outright that the review is still going",
);
assert.ok(!/what the reviewer decided/i.test(opening), "must not hand over notes");
assert.ok(!/Review notes —/.test(opening), "must not paste the notes markdown");
assert.ok(/may have questions/i.test(opening), "says the reviewer has questions");
assert.ok(/do not summarise/i.test(opening), "told not to summarise unprompted");
assert.ok(
  /do not .*change any code files/is.test(opening),
  "told not to touch code",
);
assert.ok(
  /review_deck_edit/.test(opening),
  "but told it may edit the deck when asked",
);
assert.ok(
  /[Nn]ever\s+build a new deck/.test(opening),
  "and not to build a new one instead",
);
assert.ok(/1\. The metric/.test(opening), "given the slide list for context");

// --- pressing it again reuses the same conversation ----------------------
const again = await harness.behavior.callRpc("deck_act", { deckId: deck.deckId, intent: "ask" });
assert.equal(spawns.length, 1, "no second thread");
assert.equal(again.threadId, "thr_chat1", "same conversation");
assert.equal(sends.length, 0, "and nothing is said on its behalf");

// --- finishing the deck hands the notes over, in the same thread ---------
const wrap = await harness.behavior.callRpc("deck_act", { deckId: deck.deckId, intent: "discuss" });
assert.equal(wrap.threadId, "thr_chat1", "continues the conversation");
assert.equal(spawns.length, 1, "still no second thread");
assert.equal(sends.length, 1, "now it sends the notes");
assert.ok(/been through the whole deck/i.test(sends[0]!), "and says the review is done");
assert.ok(/Review notes —/.test(sends[0]!), "with the notes attached");

await harness.lifecycle.dispose();
console.log("PASS — the chat opens as a question, not as a verdict");
