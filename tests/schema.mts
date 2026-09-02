// Schema setup must repair an older database, not just build a new one.
//
// This exists because index-keyed migrations silently skipped a column on a
// live database while every fresh-start test passed.
import assert from "node:assert/strict";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import plugin from "../server.ts";

let host = createFakePluginHost({ pluginId: "review-deck" });
await plugin(host.bb);

// A reload closes the old database handle, so always read through the current
// host rather than one captured earlier.
const columns = (table: string) =>
  (
    host.bb.storage
      .database()
      .prepare(`PRAGMA table_info(${table})`)
      .all() as { name: string }[]
  ).map((c) => c.name);

assert.ok(columns("slides").includes("patch_cache"), "fresh database has patch_cache");
assert.ok(
  columns("decks").includes("source_thread_id"),
  "fresh database has source_thread_id",
);

// Pretend this database was created by an older build that never added them.
const db = host.bb.storage.database();
db.exec("ALTER TABLE slides DROP COLUMN patch_cache");
db.exec("ALTER TABLE decks DROP COLUMN source_thread_id");
assert.ok(!columns("slides").includes("patch_cache"), "column really is gone");

host = await host.harness.lifecycle.reload(plugin);

assert.ok(
  columns("slides").includes("patch_cache"),
  "a reload adds the missing column back",
);
assert.ok(
  columns("decks").includes("source_thread_id"),
  "and the other one too",
);

await host.harness.lifecycle.dispose();
console.log("PASS — an older database is repaired on load");
