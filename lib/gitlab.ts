// Pure helpers for turning a merge-request link into the pieces the watcher
// needs, and for matching that repository to a BB project.

export interface MergeRequestRef {
  /** The GitLab host, e.g. `gitlab.example.com`. */
  hostname: string;
  /** The project path, e.g. `acme/widgets`. */
  projectPath: string;
  /** The per-project merge request number (`!142` → 142). */
  iid: number;
}

/**
 * Reads a merge-request link. Accepts the usual copied URL, with or without a
 * `/diffs` suffix, a query string, or a `#note_123` anchor.
 */
export function parseMergeRequestUrl(raw: string): MergeRequestRef | null {
  const trimmed = raw.trim();
  if (trimmed === "") return null;
  let url: URL;
  try {
    url = new URL(trimmed.includes("://") ? trimmed : `https://${trimmed}`);
  } catch {
    return null;
  }
  if (url.hostname === "") return null;
  const match = /^\/(.+?)\/-\/merge_requests\/(\d+)(?:\/|$)/.exec(url.pathname);
  if (match === null) return null;
  const projectPath = decodeURIComponent(match[1] ?? "").replace(/^\/+|\/+$/g, "");
  const iid = Number.parseInt(match[2] ?? "", 10);
  if (projectPath === "" || !Number.isSafeInteger(iid) || iid < 1) return null;
  return { hostname: url.hostname.toLowerCase(), projectPath, iid };
}

/**
 * Reduces a git remote to `host/group/project`, so an SSH remote and an HTTPS
 * one for the same repository compare equal.
 */
export function normaliseRemote(remote: string | null | undefined): string | null {
  if (typeof remote !== "string") return null;
  let value = remote.trim();
  if (value === "") return null;
  value = value.replace(/\.git$/i, "");
  // scp-style: git@host:group/project
  const scp = /^(?:[^@/]+@)?([^:/@]+):(.+)$/.exec(value);
  if (scp !== null && !value.includes("://")) {
    return `${(scp[1] ?? "").toLowerCase()}/${(scp[2] ?? "").replace(/^\/+/, "")}`;
  }
  try {
    const url = new URL(value.includes("://") ? value : `https://${value}`);
    const path = url.pathname.replace(/^\/+|\/+$/g, "");
    if (url.hostname === "" || path === "") return null;
    return `${url.hostname.toLowerCase()}/${path}`;
  } catch {
    return null;
  }
}

/** The comparison key for a merge request's repository. */
export function remoteKey(ref: MergeRequestRef): string {
  return `${ref.hostname}/${ref.projectPath}`;
}

/**
 * A finding's identity across re-reviews. Line numbers move when a branch is
 * pushed to, so the key is the file plus the finding's title. A reworded title
 * reads as a new finding, which is the safer way to be wrong.
 */
export function annotationKey(path: string, title: string): string {
  const tidy = (value: string) =>
    value.trim().toLowerCase().replace(/\s+/g, " ");
  return `${tidy(path)}::${tidy(title)}`;
}

/** The same idea for a slide, so "Looks good" survives a re-review. */
export function slideKey(title: string): string {
  return title.trim().toLowerCase().replace(/\s+/g, " ");
}

/** The commit trio GitLab needs to anchor a comment to a line. */
export interface DiffRefs {
  base_sha: string;
  start_sha: string;
  head_sha: string;
}

/**
 * Where a comment sits on a merge request diff.
 *
 * The line goes in `new_line` or `old_line`, never both — GitLab rejects a
 * position that names both, and one that names neither becomes an unanchored
 * comment at the bottom of the thread.
 */
export function diffNotePosition(
  annotation: { path: string; line: number; side: "new" | "old" },
  refs: DiffRefs,
): Record<string, unknown> {
  return {
    position_type: "text",
    base_sha: refs.base_sha,
    start_sha: refs.start_sha,
    head_sha: refs.head_sha,
    new_path: annotation.path,
    old_path: annotation.path,
    ...(annotation.side === "old"
      ? { old_line: annotation.line }
      : { new_line: annotation.line }),
  };
}
