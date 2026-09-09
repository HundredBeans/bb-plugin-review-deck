// Talking about a deck must land in the conversation the deck already has.
// Spawning a fresh thread throws away the context and is the last resort.
import assert from "node:assert/strict";
import { createFakePluginHost, makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import plugin from "../server.ts";

const spawned: string[] = [];
const sends: { threadId: string; text: string }[] = [];
const archived = new Set<string>();

const { bb, harness } = createFakePluginHost({
  pluginId: "review-deck",
  sdk: {
    projects: { list: async () => [{ id: "proj_1", name: "d", gitRemoteUrl: null, sources: [] }] },
    threads: {
      get: async ({ threadId }: { threadId: string }) =>
        makeThreadResponse({
          id: threadId,
          environmentId: "env_1",
          title: `Thread ${threadId}`,
          ...(archived.has(threadId) ? { archivedAt: 1 } : {}),
        }),
      spawn: async () => {
        const id = `thr_spawn${spawned.length + 1}`;
        spawned.push(id);
        return makeThreadResponse({ id, title: `Thread ${id}` });
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

// A deck written by an agent in an ordinary conversation.
const ctx = { threadId: "thr_work", projectId: "proj_1" };
const deck = JSON.parse(String(await harness.behavior.callAgentTool(
  "review_deck_create", { title: "Retry failed payouts", summary: "" }, ctx)));
await harness.behavior.callAgentTool("review_deck_add_slide", {
  deckId: deck.deckId, title: "The retry worker", summary: "…",
}, ctx);
await harness.behavior.callAgentTool("review_deck_finish", { deckId: deck.deckId }, ctx);

// The panel should already say where talking would land.
const before = await harness.behavior.callRpc("deck_next_actions", { deckId: deck.deckId });
assert.equal(before.chatThreadId, "thr_work", "the thread that wrote it is the chat");
assert.equal(before.chatWouldSpawn, false, "so nothing would be spawned");
assert.equal(before.chatThreadTitle, "Thread thr_work", "and it is named");

// Sending notes goes there, not into a new thread.
const sent = await harness.behavior.callRpc("deck_act", {
  deckId: deck.deckId, intent: "discuss",
});
assert.equal(sent.ok, true, sent.message);
assert.equal(spawned.length, 0, "no thread spawned");
assert.equal(sends.length, 1);
assert.equal(sends[0]!.threadId, "thr_work", "the notes land in the existing conversation");
assert.ok(/whole deck/i.test(sends[0]!.text), "and read as a wrap-up");

// It is now the deck's chat, so the panel and the next press agree.
const after = await harness.behavior.callRpc("deck_next_actions", { deckId: deck.deckId });
assert.equal(after.discussionThreadId, "thr_work", "recorded as the deck's chat");

// Asking a question also goes there and says nothing on your behalf.
const ask = await harness.behavior.callRpc("deck_act", { deckId: deck.deckId, intent: "ask" });
assert.equal(ask.threadId, "thr_work");
assert.equal(spawned.length, 0, "still nothing spawned");
assert.equal(sends.length, 1, "and no extra message");

// --- a chat this plugin opened must not outrank where you started -------
// Simulate the old state: a deck whose recorded chat is a spawned side thread
// while the conversation it came from is still alive.
bb.storage
  .database()
  .prepare(`UPDATE decks SET discussion_thread_id = 'thr_sidechat' WHERE id = ?`)
  .run(deck.deckId);

const preferred = await harness.behavior.callRpc("deck_next_actions", {
  deckId: deck.deckId,
});
assert.equal(
  preferred.chatThreadId,
  "thr_work",
  "the conversation you started from wins over a spawned side chat",
);

const back = await harness.behavior.callRpc("deck_act", {
  deckId: deck.deckId, intent: "ask",
});
assert.equal(back.threadId, "thr_work", "and talking goes there");
assert.equal(spawned.length, 0, "still nothing spawned");

// --- a deck with no conversation left does spawn, and says so -----------
const orphan = JSON.parse(String(await harness.behavior.callAgentTool(
  "review_deck_create", { title: "Orphan deck", summary: "" },
  { threadId: "thr_dead", projectId: "proj_1" })));
archived.add("thr_dead");

const orphanBefore = await harness.behavior.callRpc("deck_next_actions", {
  deckId: orphan.deckId,
});
assert.equal(orphanBefore.chatThreadId, null, "no usable conversation");
assert.equal(orphanBefore.chatWouldSpawn, true, "so the UI can warn first");

const spawnedChat = await harness.behavior.callRpc("deck_act", {
  deckId: orphan.deckId, intent: "ask",
});
assert.equal(spawnedChat.ok, true, spawnedChat.message);
assert.equal(spawned.length, 1, "one new thread, only as a last resort");
assert.equal(spawnedChat.threadId, "thr_spawn1");

await harness.lifecycle.dispose();
console.log("PASS — talking lands in the deck's existing conversation");
