// Shared vocabulary for a review deck.
//
// server.ts imports the zod schemas (runtime); app.tsx imports only the types,
// so zod never reaches the frontend bundle through this file.
import { z } from "zod";

/** How serious a finding is. Drives the colour and the sort order. */
export const SEVERITIES = [
  "blocker",
  "issue",
  "nit",
  "question",
  "praise",
  "info",
] as const;
export const severitySchema = z.enum(SEVERITIES);
export type Severity = (typeof SEVERITIES)[number];

/** Lower sorts first. */
export const SEVERITY_ORDER: Record<Severity, number> = {
  blocker: 0,
  issue: 1,
  question: 2,
  nit: 3,
  info: 4,
  praise: 5,
};

/** What a slide is for. Decides the badge and the default icon. */
export const SLIDE_KINDS = [
  "overview",
  "change",
  "risk",
  "test",
  "wrapup",
] as const;
export const slideKindSchema = z.enum(SLIDE_KINDS);
export type SlideKind = (typeof SLIDE_KINDS)[number];

/**
 * Which diff BB should compute. Mirrors the shape `bb.sdk.environments.diff*`
 * expects, so it can be spread straight into those calls.
 */
export const diffTargetSchema = z.discriminatedUnion("target", [
  z.object({ target: z.literal("uncommitted") }),
  z.object({
    target: z.literal("branch_committed"),
    mergeBaseBranch: z.string().min(1).max(300),
  }),
  z.object({
    target: z.literal("all"),
    mergeBaseBranch: z.string().min(1).max(300),
  }),
  z.object({ target: z.literal("commit"), sha: z.string().min(1).max(100) }),
]);
export type DiffTarget = z.output<typeof diffTargetSchema>;

// ---------------------------------------------------------------------------
// Diagrams
// ---------------------------------------------------------------------------

export const DIAGRAM_TONES = [
  "default",
  "added",
  "changed",
  "removed",
  "external",
] as const;
export type DiagramTone = (typeof DIAGRAM_TONES)[number];

export const flowNodeSchema = z.object({
  id: z.string().min(1).max(60),
  label: z.string().min(1).max(60),
  /** One short line under the label — a file name, a type, a count. */
  note: z.string().max(60).optional(),
  tone: z.enum(DIAGRAM_TONES).default("default"),
});
export type FlowNode = z.output<typeof flowNodeSchema>;

export const flowEdgeSchema = z.object({
  from: z.string().min(1).max(60),
  to: z.string().min(1).max(60),
  label: z.string().max(40).optional(),
  style: z.enum(["solid", "dashed"]).default("solid"),
});
export type FlowEdge = z.output<typeof flowEdgeSchema>;

export const flowDiagramSchema = z.object({
  kind: z.literal("flow"),
  title: z.string().max(120).optional(),
  direction: z.enum(["down", "right"]).default("down"),
  nodes: z.array(flowNodeSchema).min(1).max(30),
  edges: z.array(flowEdgeSchema).max(60).default([]),
});
export type FlowDiagram = z.output<typeof flowDiagramSchema>;

export const sequenceActorSchema = z.object({
  id: z.string().min(1).max(60),
  label: z.string().min(1).max(40),
  tone: z.enum(DIAGRAM_TONES).default("default"),
});
export type SequenceActor = z.output<typeof sequenceActorSchema>;

export const sequenceStepSchema = z.object({
  from: z.string().min(1).max(60),
  to: z.string().min(1).max(60),
  label: z.string().min(1).max(80),
  style: z.enum(["call", "return", "async"]).default("call"),
  /** Marks the step as new or changed by this pull request. */
  changed: z.boolean().default(false),
});
export type SequenceStep = z.output<typeof sequenceStepSchema>;

export const sequenceDiagramSchema = z.object({
  kind: z.literal("sequence"),
  title: z.string().max(120).optional(),
  actors: z.array(sequenceActorSchema).min(2).max(7),
  steps: z.array(sequenceStepSchema).min(1).max(30),
});
export type SequenceDiagram = z.output<typeof sequenceDiagramSchema>;

export const diagramSchema = z.discriminatedUnion("kind", [
  flowDiagramSchema,
  sequenceDiagramSchema,
]);
export type Diagram = z.output<typeof diagramSchema>;

// ---------------------------------------------------------------------------
// Slides
// ---------------------------------------------------------------------------

/** A file shown on a slide. `patch` is optional: BB fetches it when absent. */
export const slideFileSchema = z.object({
  path: z.string().min(1).max(400),
  previousPath: z.string().min(1).max(400).optional(),
  /** Why this file is on this slide. One short line. */
  role: z.string().max(120).optional(),
  /** A ready-made unified patch. Leave it out and BB reads the real diff. */
  patch: z.string().max(400_000).optional(),
});
export type SlideFile = z.output<typeof slideFileSchema>;

/** A finding pinned to one line of one file. */
export const annotationInputSchema = z.object({
  path: z.string().min(1).max(400),
  /** 1-based line number in the chosen side of the diff. */
  line: z.number().int().min(1).max(2_000_000),
  /** Last line when the finding covers a block. */
  endLine: z.number().int().min(1).max(2_000_000).optional(),
  side: z.enum(["new", "old"]).default("new"),
  severity: severitySchema.default("issue"),
  title: z.string().min(1).max(160),
  /** What happens, then the impact, then the scope. Markdown is allowed. */
  body: z.string().max(4000).default(""),
  /** A concrete replacement for the flagged lines. */
  suggestion: z.string().max(4000).optional(),
});
export type AnnotationInput = z.output<typeof annotationInputSchema>;

/** An annotation once it is stored, with the id the reviewer replies to. */
export type Annotation = AnnotationInput & { id: string };

/** A slide-level point that does not belong to one line. */
export const suggestionSchema = z.object({
  severity: severitySchema.default("info"),
  title: z.string().min(1).max(160),
  body: z.string().max(4000).default(""),
});
export type Suggestion = z.output<typeof suggestionSchema>;

export const slideInputSchema = z.object({
  title: z.string().min(1).max(160),
  kind: slideKindSchema.default("change"),
  /** Two or three sentences. What this part of the change does. */
  summary: z.string().max(4000).default(""),
  /** Optional single line: why the reviewer should care. */
  why: z.string().max(400).optional(),
  files: z.array(slideFileSchema).max(20).default([]),
  annotations: z.array(annotationInputSchema).max(60).default([]),
  suggestions: z.array(suggestionSchema).max(20).default([]),
  diagram: diagramSchema.nullish(),
});
export type SlideInput = z.output<typeof slideInputSchema>;

// ---------------------------------------------------------------------------
// What the frontend reads
// ---------------------------------------------------------------------------

export const REVIEW_STATES = ["pending", "approved", "needs-work"] as const;
export type ReviewState = (typeof REVIEW_STATES)[number];

export const ANNOTATION_VERDICTS = ["open", "accepted", "rejected"] as const;
export type AnnotationVerdict = (typeof ANNOTATION_VERDICTS)[number];

export interface DeckSummary {
  id: string;
  title: string;
  summary: string;
  status: "draft" | "ready";
  projectId: string | null;
  environmentId: string | null;
  threadId: string | null;
  shortstat: string;
  slideCount: number;
  annotationCount: number;
  blockerCount: number;
  approvedCount: number;
  needsWorkCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface Slide {
  id: string;
  position: number;
  title: string;
  kind: SlideKind;
  summary: string;
  why: string | null;
  files: SlideFile[];
  annotations: Annotation[];
  suggestions: Suggestion[];
  diagram: Diagram | null;
  state: ReviewState;
  note: string;
}

export interface Deck extends DeckSummary {
  target: DiffTarget;
  slides: Slide[];
  /** Reviewer verdicts on individual annotations, keyed by annotation id. */
  verdicts: Record<string, { verdict: AnnotationVerdict; note: string }>;
}

/** One file's patch, resolved at view time. */
export interface ResolvedPatch {
  path: string;
  previousPath: string | null;
  role: string | null;
  patch: string;
  truncated: boolean;
  /** `snapshot` means the workspace is gone and this is the stored copy. */
  source: "slide" | "environment" | "snapshot";
  error: string | null;
}

// ---------------------------------------------------------------------------
// Watched merge requests
// ---------------------------------------------------------------------------

export const WATCH_STATES = ["idle", "running", "error"] as const;
export type WatchState = (typeof WATCH_STATES)[number];

/** A merge request the plugin re-reviews whenever it gets new commits. */
export interface Watch {
  id: string;
  url: string;
  hostname: string;
  projectPath: string;
  iid: number;
  title: string;
  /** The branch the merge request targets, e.g. `main`. */
  targetBranch: string;
  /** `opened`, `merged`, `closed`, or "" before the first check. */
  mrState: string;
  draft: boolean;
  /** The BB project whose git remote matches this repository. */
  bbProjectId: string | null;
  bbProjectName: string | null;
  /** Empty means "use the default review prompt from settings". */
  prompt: string;
  enabled: boolean;
  /** The deck this watch keeps up to date. */
  deckId: string | null;
  /** Head commit of the last completed review. */
  lastSha: string | null;
  /** Head commit seen on the last check, reviewed or not. */
  headSha: string | null;
  state: WatchState;
  lastError: string | null;
  lastCheckedAt: string | null;
  lastReviewedAt: string | null;
  createdAt: string;
  /** The thread doing the review right now; open it to watch the agent work. */
  runThreadId: string | null;
  runStartedAt: string | null;
  /** How much of the deck exists so far — it grows while the review runs. */
  deckSlideCount: number;
  deckFindingCount: number;
}

// ---------------------------------------------------------------------------
// Editing a deck that already exists
// ---------------------------------------------------------------------------

/** A slide, named by its id or by the position shown in the deck. */
export const slideRefSchema = z.union([
  z.string().min(1).max(60),
  z.number().int().min(1).max(200),
]);
export type SlideRef = z.output<typeof slideRefSchema>;

/** Fields an edit may change on a slide. Anything omitted is left alone. */
export const slidePatchSchema = z.object({
  title: z.string().min(1).max(160).optional(),
  kind: slideKindSchema.optional(),
  summary: z.string().max(4000).optional(),
  why: z.string().max(400).nullish(),
  files: z.array(slideFileSchema).max(20).optional(),
  diagram: diagramSchema.nullish(),
});

/** Fields an edit may change on a finding. */
export const annotationPatchSchema = z.object({
  path: z.string().min(1).max(400).optional(),
  line: z.number().int().min(1).max(2_000_000).optional(),
  endLine: z.number().int().min(1).max(2_000_000).nullish(),
  side: z.enum(["new", "old"]).optional(),
  severity: severitySchema.optional(),
  title: z.string().min(1).max(160).optional(),
  body: z.string().max(4000).optional(),
  suggestion: z.string().max(4000).nullish(),
});

export const deckOperationSchema = z.discriminatedUnion("op", [
  z
    .object({
      op: z.literal("set_deck"),
      title: z.string().min(1).max(160).optional(),
      summary: z.string().max(4000).optional(),
    })
    .strict(),
  z
    .object({
      op: z.literal("add_slide"),
      /** Insert after this slide; omit to append at the end. */
      after: slideRefSchema.optional(),
    })
    .merge(slideInputSchema.partial({ title: true }))
    .extend({ title: z.string().min(1).max(160) })
    .strict(),
  z
    .object({ op: z.literal("edit_slide"), slide: slideRefSchema })
    .merge(slidePatchSchema)
    .strict(),
  z.object({ op: z.literal("remove_slide"), slide: slideRefSchema }).strict(),
  z
    .object({
      op: z.literal("move_slide"),
      slide: slideRefSchema,
      to: z.number().int().min(1).max(200),
    })
    .strict(),
  z
    .object({ op: z.literal("add_finding"), slide: slideRefSchema })
    .merge(annotationInputSchema)
    .strict(),
  z
    .object({ op: z.literal("edit_finding"), finding: z.string().min(1).max(80) })
    .merge(annotationPatchSchema)
    .strict(),
  z
    .object({ op: z.literal("remove_finding"), finding: z.string().min(1).max(80) })
    .strict(),
]);
export type DeckOperation = z.output<typeof deckOperationSchema>;
