// A very small unified-patch reader.
//
// BB ships its own diff viewer, but that viewer cannot put a note between two
// lines of code. The annotated view needs the individual lines, so this file
// turns a unified patch into rows the renderer can walk.

export type PatchLineKind = "context" | "add" | "del" | "marker";

export interface PatchLine {
  kind: PatchLineKind;
  /** 1-based line number on the old side, or null for an added line. */
  oldLine: number | null;
  /** 1-based line number on the new side, or null for a removed line. */
  newLine: number | null;
  text: string;
}

export interface PatchHunk {
  /** The text after the second `@@`, e.g. the enclosing function name. */
  heading: string;
  oldStart: number;
  newStart: number;
  lines: PatchLine[];
}

export interface ParsedPatch {
  hunks: PatchHunk[];
  isBinary: boolean;
  /** Set when the patch had no `@@` hunk at all. */
  isEmpty: boolean;
}

const HUNK = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@ ?(.*)$/;

export function parsePatch(patch: string): ParsedPatch {
  const hunks: PatchHunk[] = [];
  let current: PatchHunk | null = null;
  let oldLine = 0;
  let newLine = 0;
  let isBinary = false;

  for (const raw of patch.split("\n")) {
    const match = HUNK.exec(raw);
    if (match !== null) {
      oldLine = Number.parseInt(match[1] ?? "1", 10);
      newLine = Number.parseInt(match[3] ?? "1", 10);
      current = {
        heading: (match[5] ?? "").trim(),
        oldStart: oldLine,
        newStart: newLine,
        lines: [],
      };
      hunks.push(current);
      continue;
    }
    if (current === null) {
      if (raw.startsWith("Binary files") || raw.startsWith("GIT binary patch")) {
        isBinary = true;
      }
      continue; // still in the `diff --git` / `---` / `+++` preamble
    }
    if (raw.startsWith("\\")) {
      current.lines.push({
        kind: "marker",
        oldLine: null,
        newLine: null,
        text: raw.slice(1).trim(),
      });
      continue;
    }
    const marker = raw.slice(0, 1);
    const text = raw.slice(1);
    if (marker === "+") {
      current.lines.push({ kind: "add", oldLine: null, newLine, text });
      newLine += 1;
    } else if (marker === "-") {
      current.lines.push({ kind: "del", oldLine, newLine: null, text });
      oldLine += 1;
    } else if (marker === " " || raw === "") {
      current.lines.push({ kind: "context", oldLine, newLine, text });
      oldLine += 1;
      newLine += 1;
    }
    // Anything else (a stray `diff --git` for a second file) is ignored.
  }

  return { hunks, isBinary, isEmpty: hunks.length === 0 };
}

/** True when `line` on `side` is inside one of the patch's hunks. */
export function patchCoversLine(
  parsed: ParsedPatch,
  side: "new" | "old",
  line: number,
): boolean {
  for (const hunk of parsed.hunks) {
    for (const entry of hunk.lines) {
      const value = side === "new" ? entry.newLine : entry.oldLine;
      if (value === line) return true;
    }
  }
  return false;
}
