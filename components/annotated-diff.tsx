// A diff with the review notes sitting on the lines they talk about.
//
// BB's own diff viewer (experimental_Diff) is nicer to read and is offered as
// the "Plain diff" toggle in the slide. This renderer exists for the other
// job: dropping a finding card between two lines of code.
import { useMemo, useState } from "react";
import { Markdown } from "@get-bb/plugin-sdk/app";
import type { Annotation, AnnotationVerdict, ResolvedPatch } from "@/lib/deck-schema";
import { parsePatch, type PatchLine } from "@/lib/patch";
import { SEVERITY_STYLE, SeverityChip } from "@/components/severity";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";

export interface Verdict {
  verdict: AnnotationVerdict;
  note: string;
}

interface FindingProps {
  annotation: Annotation;
  verdict: Verdict | undefined;
  onVerdict: (verdict: AnnotationVerdict, note: string) => void;
  /** Shown when the finding could not be placed on a line. */
  showLocation?: boolean;
}

function AnnotationCard({
  annotation,
  verdict,
  onVerdict,
  showLocation = false,
}: FindingProps) {
  const style = SEVERITY_STYLE[annotation.severity] ?? SEVERITY_STYLE.info;
  const [note, setNote] = useState(verdict?.note ?? "");
  const [replying, setReplying] = useState(false);
  const current = verdict?.verdict ?? "open";

  return (
    <div
      className={cn(
        "my-1.5 rounded-md border border-l-[3px] border-border bg-card px-3 py-2.5 font-sans",
        style.accent,
      )}
    >
      <div className="flex flex-wrap items-center gap-2">
        <SeverityChip severity={annotation.severity} />
        <span className="min-w-0 flex-1 text-[13px] font-medium leading-snug text-foreground">
          {annotation.title}
        </span>
        {current === "open" ? null : (
          <span
            className={cn(
              "shrink-0 rounded-full border px-2 py-0.5 text-[11px] leading-none",
              current === "accepted"
                ? "border-primary/40 bg-primary/10 text-primary"
                : "border-border bg-muted text-muted-foreground",
            )}
          >
            {current === "accepted" ? "You agreed" : "You disagreed"}
          </span>
        )}
      </div>

      {showLocation ? (
        <p className="mt-1 font-mono text-[11px] text-muted-foreground">
          {annotation.path}:{annotation.line}
          {annotation.endLine !== undefined && annotation.endLine !== annotation.line
            ? `–${annotation.endLine}`
            : ""}{" "}
          ({annotation.side} side)
        </p>
      ) : null}

      {annotation.body.trim() === "" ? null : (
        <div className="mt-1.5 text-[13px] leading-relaxed text-muted-foreground [&_p]:my-1">
          <Markdown content={annotation.body} />
        </div>
      )}

      {annotation.suggestion === undefined ||
      annotation.suggestion.trim() === "" ? null : (
        <div className="mt-2">
          <p className="mb-1 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
            Suggested change
          </p>
          <pre className="my-0 overflow-x-auto rounded border border-border bg-muted/60 px-2.5 py-2 font-mono text-[12px] leading-relaxed text-foreground">
            {annotation.suggestion}
          </pre>
        </div>
      )}

      <div className="mt-2 flex flex-wrap items-center gap-1.5">
        <Button
          variant={current === "accepted" ? "secondary" : "ghost"}
          size="sm"
          className="h-6 px-2 text-[11px]"
          onClick={() => onVerdict(current === "accepted" ? "open" : "accepted", note)}
        >
          <Icon name="Check" className="size-3" />
          Agree
        </Button>
        <Button
          variant={current === "rejected" ? "secondary" : "ghost"}
          size="sm"
          className="h-6 px-2 text-[11px]"
          onClick={() => onVerdict(current === "rejected" ? "open" : "rejected", note)}
        >
          <Icon name="X" className="size-3" />
          Disagree
        </Button>
        <Button
          variant="ghost"
          size="sm"
          className="h-6 px-2 text-[11px] text-muted-foreground"
          onClick={() => setReplying((open) => !open)}
        >
          <Icon name="MessageSquare" className="size-3" />
          {note.trim() === "" ? "Reply" : "Edit reply"}
        </Button>
        {note.trim() === "" || replying ? null : (
          <span className="min-w-0 flex-1 truncate text-[11px] text-muted-foreground">
            “{note.trim()}”
          </span>
        )}
      </div>

      {replying ? (
        <div className="mt-2">
          <textarea
            value={note}
            onChange={(event) => setNote(event.target.value)}
            rows={2}
            placeholder="Why you agree or disagree — this goes back to the agent."
            className="w-full resize-y rounded border border-border bg-background px-2 py-1.5 text-[12px] text-foreground outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
          />
          <div className="mt-1.5 flex gap-1.5">
            <Button
              size="sm"
              className="h-6 px-2 text-[11px]"
              onClick={() => {
                onVerdict(current, note);
                setReplying(false);
              }}
            >
              Save reply
            </Button>
            <Button
              variant="ghost"
              size="sm"
              className="h-6 px-2 text-[11px]"
              onClick={() => {
                setNote(verdict?.note ?? "");
                setReplying(false);
              }}
            >
              Cancel
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

const LINE_STYLE: Record<PatchLine["kind"], string> = {
  add: "bg-primary/10",
  del: "bg-destructive/10",
  context: "",
  marker: "text-muted-foreground italic",
};

const LINE_MARK: Record<PatchLine["kind"], string> = {
  add: "+",
  del: "-",
  context: " ",
  marker: " ",
};

export function AnnotatedDiff({
  file,
  annotations,
  verdicts,
  onVerdict,
}: {
  file: ResolvedPatch;
  annotations: Annotation[];
  verdicts: Record<string, Verdict>;
  onVerdict: (annotationId: string, verdict: AnnotationVerdict, note: string) => void;
}) {
  const parsed = useMemo(() => parsePatch(file.patch), [file.patch]);

  // Where each finding is pinned, and which code lines it covers.
  const { anchored, unplaced, highlighted } = useMemo(() => {
    const seen = new Set<string>();
    for (const hunk of parsed.hunks) {
      for (const line of hunk.lines) {
        if (line.newLine !== null) seen.add(`new:${line.newLine}`);
        if (line.oldLine !== null) seen.add(`old:${line.oldLine}`);
      }
    }
    const byKey = new Map<string, Annotation[]>();
    const covered = new Map<string, string>();
    const left: Annotation[] = [];
    for (const annotation of annotations) {
      const last = Math.max(annotation.line, annotation.endLine ?? annotation.line);
      const key = `${annotation.side}:${last}`;
      if (!seen.has(key)) {
        left.push(annotation);
        continue;
      }
      const bucket = byKey.get(key) ?? [];
      bucket.push(annotation);
      byKey.set(key, bucket);
      for (let line = annotation.line; line <= last; line += 1) {
        covered.set(`${annotation.side}:${line}`, annotation.severity);
      }
    }
    return { anchored: byKey, unplaced: left, highlighted: covered };
  }, [annotations, parsed]);

  /**
   * The file body as a flat list. A run of code lines ends wherever a finding
   * is pinned, so the finding can be rendered outside the sideways scroll.
   */
  const blocks = useMemo(() => {
    type Block =
      | { kind: "hunk"; heading: string; oldStart: number; newStart: number }
      | { kind: "lines"; lines: PatchLine[] }
      | { kind: "notes"; annotations: Annotation[] };
    const out: Block[] = [];
    for (const hunk of parsed.hunks) {
      out.push({
        kind: "hunk",
        heading: hunk.heading,
        oldStart: hunk.oldStart,
        newStart: hunk.newStart,
      });
      let run: PatchLine[] = [];
      for (const line of hunk.lines) {
        run.push(line);
        const oldKey = line.oldLine === null ? null : `old:${line.oldLine}`;
        const newKey = line.newLine === null ? null : `new:${line.newLine}`;
        const cards = [
          ...(newKey !== null ? (anchored.get(newKey) ?? []) : []),
          ...(oldKey !== null && line.newLine === null
            ? (anchored.get(oldKey) ?? [])
            : []),
        ];
        if (cards.length === 0) continue;
        out.push({ kind: "lines", lines: run });
        run = [];
        out.push({ kind: "notes", annotations: cards });
      }
      if (run.length > 0) out.push({ kind: "lines", lines: run });
    }
    return out;
  }, [anchored, parsed]);

  const gutter =
    "w-11 shrink-0 select-none border-r border-border/60 px-1.5 text-right text-[11px] leading-[1.5rem] text-muted-foreground/70";

  return (
    <section className="overflow-hidden rounded-lg border border-border bg-card">
      <header className="flex flex-wrap items-center gap-x-2 gap-y-1 border-b border-border bg-muted/40 px-3 py-2">
        <Icon name="Code" className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="min-w-0 break-all font-mono text-[12px] font-medium text-foreground">
          {file.path}
        </span>
        {file.previousPath === null ? null : (
          <span className="font-mono text-[11px] text-muted-foreground">
            (was {file.previousPath})
          </span>
        )}
        {file.role === null ? null : (
          <span className="text-[11px] text-muted-foreground">— {file.role}</span>
        )}
        {annotations.length === 0 ? null : (
          <span className="ml-auto shrink-0 text-[11px] text-muted-foreground">
            {annotations.length} finding{annotations.length === 1 ? "" : "s"}
          </span>
        )}
      </header>

      {file.error !== null ? (
        <p className="px-3 py-3 text-[12px] text-muted-foreground">{file.error}</p>
      ) : parsed.isBinary ? (
        <p className="px-3 py-3 text-[12px] text-muted-foreground">
          Binary file — nothing to show.
        </p>
      ) : parsed.isEmpty ? (
        <p className="px-3 py-3 text-[12px] text-muted-foreground">
          No changes in the reviewed range for this file.
        </p>
      ) : (
        <div>
          {blocks.map((block, index) => {
            if (block.kind === "hunk") {
              return (
                <div
                  key={index}
                  className="flex items-center gap-2 border-y border-border/60 bg-muted/30 px-3 py-1 font-mono text-[11px] text-muted-foreground"
                >
                  <span>
                    @@ −{block.oldStart} +{block.newStart} @@
                  </span>
                  {block.heading === "" ? null : (
                    <span className="truncate">{block.heading}</span>
                  )}
                </div>
              );
            }
            if (block.kind === "notes") {
              return (
                <div
                  key={index}
                  className="border-y border-border/50 bg-background/60 px-2 py-0.5 sm:pl-[5.5rem]"
                >
                  {block.annotations.map((annotation) => (
                    <AnnotationCard
                      key={annotation.id}
                      annotation={annotation}
                      verdict={verdicts[annotation.id]}
                      onVerdict={(verdict, note) =>
                        onVerdict(annotation.id, verdict, note)
                      }
                    />
                  ))}
                </div>
              );
            }
            // Only the code scrolls sideways. Findings stay in normal flow so
            // their text wraps to the panel instead of running off the edge.
            return (
              <div key={index} className="overflow-x-auto">
                <div className="min-w-max font-mono text-[12px]">
                  {block.lines.map((line, lineIndex) => {
                    const oldKey =
                      line.oldLine === null ? null : `old:${line.oldLine}`;
                    const newKey =
                      line.newLine === null ? null : `new:${line.newLine}`;
                    const mark =
                      (newKey !== null ? highlighted.get(newKey) : undefined) ??
                      (oldKey !== null ? highlighted.get(oldKey) : undefined);
                    return (
                      <div
                        key={lineIndex}
                        className={cn(
                          "flex items-start",
                          LINE_STYLE[line.kind],
                          mark !== undefined &&
                            "border-l-2 border-l-primary/70 bg-primary/5",
                        )}
                      >
                        <span className={gutter}>{line.oldLine ?? ""}</span>
                        <span className={gutter}>{line.newLine ?? ""}</span>
                        <pre className="my-0 flex-1 whitespace-pre px-2 leading-[1.5rem] text-foreground">
                          <span className="select-none text-muted-foreground/70">
                            {LINE_MARK[line.kind]}
                          </span>
                          {line.text}
                        </pre>
                      </div>
                    );
                  })}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {unplaced.length === 0 ? null : (
        <div className="border-t border-border px-3 py-2">
          <p className="mb-1 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
            Findings outside the shown lines
          </p>
          {unplaced.map((annotation) => (
            <AnnotationCard
              key={annotation.id}
              annotation={annotation}
              verdict={verdicts[annotation.id]}
              onVerdict={(verdict, note) => onVerdict(annotation.id, verdict, note)}
              showLocation
            />
          ))}
        </div>
      )}

      {file.truncated ? (
        <p className="border-t border-border px-3 py-2 text-[11px] text-muted-foreground">
          This diff was cut short because the file is large.
        </p>
      ) : null}
    </section>
  );
}

export { AnnotationCard };
