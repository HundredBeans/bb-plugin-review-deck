// The `/` menu's matching rules. These decide whether the menu opens at all,
// so a wrong answer here is a field that silently does nothing.
import assert from "node:assert/strict";
import { matchSkills, slashTokenAt } from "../components/prompt-field.tsx";

// --- when the menu opens -------------------------------------------------
assert.deepEqual(slashTokenAt("/code", 5), { start: 0, query: "code" }, "at the start");
assert.deepEqual(slashTokenAt("review /co", 10), { start: 7, query: "co" }, "after a space");
assert.deepEqual(slashTokenAt("a\n/co", 5), { start: 2, query: "co" }, "after a newline");
assert.deepEqual(slashTokenAt("/", 1), { start: 0, query: "" }, "a bare slash lists everything");

// --- when it must stay shut ----------------------------------------------
assert.equal(slashTokenAt("src/config.ts", 13), null, "a file path is not a skill");
assert.equal(slashTokenAt("look at src/a", 13), null, "…even mid-sentence");
assert.equal(slashTokenAt("and/or", 6), null, "no slash inside a word");
assert.equal(slashTokenAt("plain text", 10), null, "no slash at all");
assert.equal(slashTokenAt("/code review", 12), null, "the token ends at whitespace");

// The caret matters, not the whole string.
assert.deepEqual(slashTokenAt("/code review", 5), { start: 0, query: "code" }, "caret inside the token");

// --- ranking -------------------------------------------------------------
const skills = [
  { name: "code-review", description: "Review a pull request", scope: "bb-user" },
  { name: "tdd", description: "Test-driven development", scope: "bb-user" },
  { name: "my-code", description: "Something else", scope: "bb-user" },
  { name: "grill-me", description: "Stress-test a code plan", scope: "bb-user" },
];
const hits = matchSkills(skills, "code").map((s) => s.name);
assert.equal(hits[0], "code-review", "a name that starts with the query wins");
assert.ok(hits.indexOf("my-code") < hits.indexOf("grill-me"), "name beats description");
assert.ok(hits.includes("grill-me"), "a description match still shows");
assert.ok(!hits.includes("tdd"), "and a non-match does not");

assert.equal(matchSkills(skills, "").length, 4, "an empty query lists everything");
assert.equal(matchSkills(skills, "", 2).length, 2, "up to the limit");
assert.equal(matchSkills(skills, "CODE")[0]?.name, "code-review", "matching ignores case");

console.log("PASS — the slash menu opens on skills and not on file paths");
