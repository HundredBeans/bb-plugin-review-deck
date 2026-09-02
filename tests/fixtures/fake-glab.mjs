#!/usr/bin/env node
// Stands in for `glab` so the suite never touches a real GitLab.
//
// Understands the two calls the plugin makes: reading a merge request, and
// posting a discussion. Everything else exits non-zero, so an unexpected call
// shows up as a failure rather than silently passing.
const argv = process.argv.slice(2);
const path = argv.find((a) => a.startsWith("projects/")) ?? "";
const isPost = argv.includes("-X") && argv[argv.indexOf("-X") + 1] === "POST";

const mr = /merge_requests\/(\d+)$/.exec(path);
if (!isPost && mr) {
  const iid = Number(mr[1]);
  if (iid === 999999) {
    process.stderr.write("404 Not found (HTTP 404)\n");
    process.exit(1);
  }
  process.stdout.write(
    JSON.stringify({
      iid,
      title: `Fake merge request !${iid}`,
      description: "Body of the fake merge request.",
      state: process.env.FAKE_MR_STATE ?? "opened",
      draft: process.env.FAKE_MR_DRAFT === "1",
      sha: process.env.FAKE_MR_SHA ?? "aaaaaaaaaaaa",
      source_branch: `feature-${iid}`,
      target_branch: "main",
      web_url: `https://gitlab.example.com/acme/widgets/-/merge_requests/${iid}`,
      diff_refs: { base_sha: "base00", start_sha: "start0", head_sha: "head00" },
    }),
  );
  process.exit(0);
}

if (isPost && /\/discussions$/.test(path)) {
  process.stdout.write(JSON.stringify({ id: "disc1", notes: [{ type: "DiffNote" }] }));
  process.exit(0);
}

process.stderr.write(`fake-glab: unexpected call: ${argv.join(" ")}\n`);
process.exit(1);
