// One slide: what changed here, why it matters, the code, and the findings.
import { useEffect, useState } from "react";
import {
  Markdown,
  experimental_Diff as Diff,
  useRpc,
} from "@get-bb/plugin-sdk/app";
import type {
  Annotation,
  AnnotationVerdict,
  Deck,
  ResolvedPatch,
  ReviewState,
  Slide,
} from "@/lib/deck-schema";
import type { rpcContract } from "@/server";
import { AnnotatedDiff, AnnotationCard, type Verdict } from "@/components/annotated-diff";
import { DiagramView } from "@/components/diagram";
import { SeverityChip, SlideKindChip } from "@/components/severity";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";

/** Patches for the slide, fetched when the slide is opened. */
function usePatches(deckId: string, slideId: string) {
  const rpc = useRpc<typeof rpcContract>();
  const [patches, setPatches] = useState<ResolvedPatch[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    setPatches(null);
    setError(null);
    rpc.call("slide_patches", { deckId, slideId }).then(
      (result) => {
        if (!live) return;
        setPatches(result.patches as ResolvedPatch[]);
      },
      (cause: unknown) => {
        if (!live) return;
        setError(cause instanceof Error ? cause.message : String(cause));
      },
    );
    return () => {
      live = false;
    };
  }, [rpc, deckId, slideId]);

  return { patches, error };
}

const STATE_LABEL: Record<ReviewState, string> = {
  pending: "Not reviewed",
  approved: "Looks good",
  "needs-work": "Needs work",
};

export function SlideView({
  deck,
  slide,
  onVerdict,
  onState,
  onAsk,
}: {
  deck: Deck;
  slide: Slide;
  onVerdict: (annotationId: string, verdict: AnnotationVerdict, note: string) => void;
  onState: (state: ReviewState, note: string) => void;
  /** Start (or continue) a chat about this slide. */
  onAsk?: () => void;
}) {
  const { patches, error } = usePatches(deck.id, slide.id);
  const [plain, setPlain] = useState(false);
  // Seeded once per slide: app.tsx remounts this component when the slide
  // changes, so an in-flight refetch cannot overwrite what is being typed.
  const [note, setNote] = useState(slide.note);

  const verdicts = deck.verdicts as Record<string, Verdict>;
  const byPath = new Map<string, Annotation[]>();
  for (const annotation of slide.annotations) {
    const bucket = byPath.get(annotation.path) ?? [];
    bucket.push(annotation);
    byPath.set(annotation.path, bucket);
  }
  const shownPaths = new Set(slide.files.map((file) => file.path));
  const orphans = slide.annotations.filter(
    (annotation) => !shownPaths.has(annotation.path),
  );

  return (
    <article className="space-y-5">
      <header>
        <div className="flex flex-wrap items-center gap-2">
          <SlideKindChip kind={slide.kind} />
          {slide.annotations.some((item) => item.severity === "blocker") ? (
            <SeverityChip severity="blocker" />
          ) : null}
        </div>
        <div className="mt-2 flex items-start gap-2">
          <h2 className="min-w-0 flex-1 text-xl font-semibold leading-tight text-foreground">
            {slide.title}
          </h2>
          {onAsk === undefined ? null : (
            <Button
              variant="ghost"
              size="sm"
              className="h-7 shrink-0 px-2 text-xs text-muted-foreground"
              onClick={onAsk}
            >
              <Icon name="MessageSquare" className="size-3.5" />
              Ask about this
            </Button>
          )}
        </div>
        {slide.why === null || slide.why.trim() === "" ? null : (
          <p className="mt-1.5 text-sm text-muted-foreground">
            <span className="font-medium text-foreground">Why it matters: </span>
            {slide.why}
          </p>
        )}
      </header>

      {slide.summary.trim() === "" ? null : (
        <div className="text-sm leading-relaxed text-foreground">
          <Markdown content={slide.summary} />
        </div>
      )}

      {slide.diagram === null ? null : <DiagramView diagram={slide.diagram} />}

      {slide.suggestions.length === 0 ? null : (
        <section>
          <h3 className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
            What the agent flagged on this slide
          </h3>
          <ul className="space-y-2">
            {slide.suggestions.map((suggestion, index) => (
              <li
                key={index}
                className="rounded-lg border border-border bg-card px-3 py-2.5"
              >
                <div className="flex flex-wrap items-center gap-2">
                  <SeverityChip severity={suggestion.severity} />
                  <span className="min-w-0 flex-1 text-[13px] font-medium text-foreground">
                    {suggestion.title}
                  </span>
                </div>
                {suggestion.body.trim() === "" ? null : (
                  <div className="mt-1.5 text-[13px] leading-relaxed text-muted-foreground [&_p]:my-1">
                    <Markdown content={suggestion.body} />
                  </div>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}

      {slide.files.length === 0 ? null : (
        <section>
          <div className="mb-2 flex items-center justify-between gap-2">
            <h3 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              {slide.files.length} file{slide.files.length === 1 ? "" : "s"}
            </h3>
            <Button
              variant="ghost"
              size="sm"
              className="h-7 px-2 text-xs text-muted-foreground"
              onClick={() => setPlain((current) => !current)}
            >
              <Icon name={plain ? "MessageSquare" : "Code"} className="size-3.5" />
              {plain ? "Show notes on the code" : "Plain diff"}
            </Button>
          </div>

          {error !== null ? (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          ) : patches === null ? (
            <p className="rounded-lg border border-dashed border-border px-4 py-6 text-center text-sm text-muted-foreground">
              Loading the diff…
            </p>
          ) : (
            <div className="space-y-3">
              {patches.map((file) =>
                plain ? (
                  <div
                    key={file.path}
                    className="overflow-hidden rounded-lg border border-border bg-card"
                  >
                    <header className="flex items-center gap-2 border-b border-border bg-muted/40 px-3 py-2">
                      <Icon name="Code" className="size-3.5 text-muted-foreground" />
                      <span className="break-all font-mono text-[12px] font-medium text-foreground">
                        {file.path}
                      </span>
                    </header>
                    {file.patch === "" ? (
                      <p className="px-3 py-3 text-[12px] text-muted-foreground">
                        {file.error ?? "Nothing to show."}
                      </p>
                    ) : (
                      <Diff patch={file.patch} path={file.path} />
                    )}
                  </div>
                ) : (
                  <AnnotatedDiff
                    key={file.path}
                    file={file}
                    annotations={byPath.get(file.path) ?? []}
                    verdicts={verdicts}
                    onVerdict={onVerdict}
                  />
                ),
              )}
            </div>
          )}
        </section>
      )}

      {orphans.length === 0 ? null : (
        <section>
          <h3 className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
            Findings in files this slide does not show
          </h3>
          {orphans.map((annotation) => (
            <AnnotationCard
              key={annotation.id}
              annotation={annotation}
              verdict={verdicts[annotation.id]}
              onVerdict={(verdict, replyNote) =>
                onVerdict(annotation.id, verdict, replyNote)
              }
              showLocation
            />
          ))}
        </section>
      )}

      <footer className="rounded-lg border border-border bg-card px-3 py-3">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-xs font-medium text-muted-foreground">
            Your call on this slide
          </span>
          <span
            className={cn(
              "rounded-full border px-2 py-0.5 text-[11px] leading-none",
              slide.state === "approved"
                ? "border-primary/40 bg-primary/10 text-primary"
                : slide.state === "needs-work"
                  ? "border-destructive/40 bg-destructive/10 text-destructive"
                  : "border-border bg-muted text-muted-foreground",
            )}
          >
            {STATE_LABEL[slide.state]}
          </span>
        </div>
        <textarea
          value={note}
          onChange={(event) => setNote(event.target.value)}
          onBlur={() => {
            if (note !== slide.note) onState(slide.state, note);
          }}
          rows={2}
          placeholder="Anything you want the agent to know about this slide."
          className="mt-2 w-full resize-y rounded border border-border bg-background px-2.5 py-2 text-[13px] text-foreground outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
        />
        <div className="mt-2 flex flex-wrap gap-2">
          <Button
            variant={slide.state === "approved" ? "default" : "outline"}
            size="sm"
            className="h-7 text-xs"
            onClick={() =>
              onState(slide.state === "approved" ? "pending" : "approved", note)
            }
          >
            <Icon name="CircleCheck" className="size-3.5" />
            Looks good
          </Button>
          <Button
            variant={slide.state === "needs-work" ? "destructive" : "outline"}
            size="sm"
            className="h-7 text-xs"
            onClick={() =>
              onState(slide.state === "needs-work" ? "pending" : "needs-work", note)
            }
          >
            <Icon name="AlertTriangle" className="size-3.5" />
            Needs work
          </Button>
        </div>
      </footer>
    </article>
  );
}
