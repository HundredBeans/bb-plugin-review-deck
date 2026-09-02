// The shape of an inline comment. Getting this wrong does not error — the
// comment just lands unanchored at the bottom of the merge request.
import assert from "node:assert/strict";
import { diffNotePosition, parseMergeRequestUrl } from "../lib/gitlab.ts";

const refs = { base_sha: "aaa", start_sha: "bbb", head_sha: "ccc" };

const onNew = diffNotePosition(
  { path: "src/config.ts", line: 42, side: "new" },
  refs,
);
assert.equal(onNew.position_type, "text");
assert.equal(onNew.new_line, 42);
assert.ok(!("old_line" in onNew), "a comment on added code names only new_line");
assert.equal(onNew.new_path, "src/config.ts");
assert.equal(onNew.old_path, "src/config.ts");
assert.equal(onNew.head_sha, "ccc");

const onOld = diffNotePosition(
  { path: "src/config.ts", line: 7, side: "old" },
  refs,
);
assert.equal(onOld.old_line, 7);
assert.ok(!("new_line" in onOld), "a comment on removed code names only old_line");

// Every key GitLab requires is present and nothing is undefined.
for (const key of ["position_type", "base_sha", "start_sha", "head_sha", "new_path", "old_path"]) {
  assert.ok(onNew[key] !== undefined, `${key} must be set`);
}

assert.equal(parseMergeRequestUrl("nope")?.iid, undefined);
console.log("PASS — inline comment positions are well formed");
