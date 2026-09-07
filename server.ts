// bb-plugin-review-deck — backend entry.
//
// A review deck is a short slide show over one change. Each slide groups the
// files that belong together, carries a plain-language summary, findings
// pinned to exact lines, and an optional diagram.
//
// Three surfaces share one SQLite store:
//   * the "Review Deck" page (app.tsx, over RPC),
//   * the review_deck_* agent tools an agent calls after it reviews,
//   * the `bb review-deck` CLI command.
// Every write publishes a realtime signal so an open deck updates while the
// agent is still writing slides into it.
import { execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";
import { defineRpcContract, type BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import {
  annotationKey,
  diffNotePosition,
  normaliseRemote,
  parseMergeRequestUrl,
  remoteKey,
  slideKey,
  type MergeRequestRef,
} from "./lib/gitlab";
import {
  annotationInputSchema,
  deckOperationSchema,
  diagramSchema,
  diffTargetSchema,
  slideInputSchema,
  suggestionSchema,
  slideFileSchema,
  slideKindSchema,
  severitySchema,
  SEVERITY_ORDER,
  type Annotation,
  type Deck,
  type DeckSummary,
  type Diagram,
  type DiffTarget,
  type ResolvedPatch,
  type ReviewState,
  type Slide,
  type SlideFile,
  type DeckOperation,
  type SlideInput,
  type SlideRef,
  type Suggestion,
  type Watch,
  type WatchState,
} from "./lib/deck-schema";

export type {
  Annotation,
  Deck,
  DeckSummary,
  Diagram,
  DiffTarget,
  ResolvedPatch,
  ReviewState,
  Slide,
  SlideFile,
  Suggestion,
} from "./lib/deck-schema";

/** Realtime channel app.tsx listens on. */
const DECKS_CHANGED = "decks-changed";

/** Where a deck lives in the app. */
const deckPath = (deckId: string) => `/plugins/review-deck/review/${deckId}`;

const MAX_PATCH_BYTES = 400_000;

/** Realtime channel for the watch list. */
const WATCHES_CHANGED = "watches-changed";

/** How long a review run may sit unfinished before the watch is freed. */
const RUN_TIMEOUT_MS = 45 * 60 * 1000;

/** Consecutive failed runs before a watch stops starting reviews by itself. */
const MAX_CONSECUTIVE_FAILURES = 3;

/**
 * What a watched merge request is reviewed against when the watch does not
 * carry its own prompt. Editable in the plugin settings.
 */
const DEFAULT_REVIEW_PROMPT = [
  "Review this merge request the way a careful colleague would.",
  "",
  "Look for correctness bugs first, then anything that will bite in",
  "production: error paths, data that can be lost, migrations, concurrency,",
  "and money. Check the tests actually cover the new behaviour.",
  "",
  "Be honest about severity. Only use `blocker` when merging ships a real bug,",
  "data loss, or a security hole. A deck full of blockers is a deck nobody",
  "reads.",
].join("\n");

// ---------------------------------------------------------------------------
// Rows
// ---------------------------------------------------------------------------

interface DeckRow {
  id: string;
  title: string;
  summary: string;
  status: string;
  project_id: string | null;
  environment_id: string | null;
  thread_id: string | null;
  target: string;
  shortstat: string;
  created_at: string;
  updated_at: string;
}

interface SlideRow {
  id: string;
  deck_id: string;
  position: number;
  title: string;
  kind: string;
  summary: string;
  why: string | null;
  files: string;
  annotations: string;
  suggestions: string;
  diagram: string | null;
}

interface SlideStateRow {
  slide_id: string;
  state: string;
  note: string;
}

interface VerdictRow {
  annotation_id: string;
  verdict: string;
  note: string;
}

function parseJson<T>(raw: string | null, fallback: T): T {
  if (raw === null || raw === "") return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

// ---------------------------------------------------------------------------
// RPC contract
// ---------------------------------------------------------------------------

const jsonValue: z.ZodType<unknown> = z.any();

export const rpcContract = defineRpcContract({
  decks_list: {
    input: z.object({ projectId: z.string().nullish() }).strict(),
    output: z.object({ decks: z.array(jsonValue) }),
  },
  deck_get: {
    input: z.object({ deckId: z.string().min(1) }).strict(),
    output: z.object({ deck: jsonValue }),
  },
  deck_for_thread: {
    input: z.object({ threadId: z.string().min(1) }).strict(),
    output: z.object({ deckId: z.string().nullable() }),
  },
  deck_delete: {
    input: z.object({ deckId: z.string().min(1) }).strict(),
    output: z.object({ removed: z.boolean() }),
  },
  slide_patches: {
    input: z
      .object({ deckId: z.string().min(1), slideId: z.string().min(1) })
      .strict(),
    output: z.object({ patches: z.array(jsonValue) }),
  },
  slide_set_state: {
    input: z
      .object({
        deckId: z.string().min(1),
        slideId: z.string().min(1),
        state: z.enum(["pending", "approved", "needs-work"]),
        note: z.string().max(4000).optional(),
      })
      .strict(),
    output: z.object({ ok: z.literal(true) }),
  },
  annotation_set_verdict: {
    input: z
      .object({
        deckId: z.string().min(1),
        annotationId: z.string().min(1),
        verdict: z.enum(["open", "accepted", "rejected"]),
        note: z.string().max(2000).optional(),
      })
      .strict(),
    output: z.object({ ok: z.literal(true) }),
  },
  deck_notes: {
    input: z.object({ deckId: z.string().min(1) }).strict(),
    output: z.object({ markdown: z.string() }),
  },
  deck_send_notes: {
    input: z.object({ deckId: z.string().min(1) }).strict(),
    output: z.object({
      sent: z.boolean(),
      threadId: z.string().nullable(),
      message: z.string(),
    }),
  },
  watches_list: {
    input: z.null(),
    output: z.object({
      watches: z.array(jsonValue),
      defaultPrompt: z.string(),
      autoReview: z.boolean(),
    }),
  },
  watch_add: {
    input: z
      .object({
        url: z.string().min(1).max(2000),
        prompt: z.string().max(8000).optional(),
      })
      .strict(),
    output: z.object({
      ok: z.boolean(),
      watchId: z.string().nullable(),
      message: z.string(),
    }),
  },
  watch_update: {
    input: z
      .object({
        watchId: z.string().min(1),
        prompt: z.string().max(8000).optional(),
        enabled: z.boolean().optional(),
      })
      .strict(),
    output: z.object({ ok: z.literal(true) }),
  },
  watch_remove: {
    input: z.object({ watchId: z.string().min(1) }).strict(),
    output: z.object({ removed: z.boolean() }),
  },
  watch_run_now: {
    input: z.object({ watchId: z.string().min(1) }).strict(),
    output: z.object({ started: z.boolean(), message: z.string() }),
  },
  thread_review_start: {
    input: z
      .object({
        threadId: z.string().min(1),
        prompt: z.string().max(8000).optional(),
      })
      .strict(),
    output: z.object({ started: z.boolean(), message: z.string() }),
  },
  deck_next_actions: {
    input: z.object({ deckId: z.string().min(1) }).strict(),
    output: z.object({
      agreedCount: z.number(),
      openCount: z.number(),
      canPostToMr: z.boolean(),
      mrUrl: z.string().nullable(),
      mrLabel: z.string().nullable(),
      replyThreadId: z.string().nullable(),
      /** The conversation attached to this deck, if one has been started. */
      discussionThreadId: z.string().nullable(),
    }),
  },
  deck_act: {
    input: z
      .object({
        deckId: z.string().min(1),
        intent: z.enum(["ask", "discuss", "fix"]),
      })
      .strict(),
    output: z.object({
      ok: z.boolean(),
      threadId: z.string().nullable(),
      message: z.string(),
    }),
  },
  deck_discuss_slide: {
    input: z
      .object({ deckId: z.string().min(1), slideId: z.string().min(1) })
      .strict(),
    output: z.object({
      ok: z.boolean(),
      threadId: z.string().nullable(),
      message: z.string(),
    }),
  },
  deck_post_to_mr: {
    input: z.object({ deckId: z.string().min(1) }).strict(),
    output: z.object({
      posted: z.number(),
      failed: z.array(z.object({ title: z.string(), reason: z.string() })),
      message: z.string(),
    }),
  },
  skills_list: {
    input: z.object({ projectId: z.string().nullish() }).strict(),
    output: z.object({
      skills: z.array(
        z.object({
          name: z.string(),
          description: z.string(),
          scope: z.string(),
        }),
      ),
    }),
  },
  thread_publish_review: {
    input: z
      .object({
        threadId: z.string().min(1),
        note: z.string().max(4000).optional(),
      })
      .strict(),
    output: z.object({ ok: z.boolean(), message: z.string() }),
  },
  deck_attach: {
    input: z
      .object({ deckId: z.string().min(1), threadId: z.string().min(1) })
      .strict(),
    output: z.object({ ok: z.literal(true) }),
  },
  deck_detach: {
    input: z.object({ threadId: z.string().min(1) }).strict(),
    output: z.object({ detached: z.boolean() }),
  },
  thread_review_status: {
    input: z.object({ threadId: z.string().min(1) }).strict(),
    output: z.object({
      running: z.boolean(),
      runThreadId: z.string().nullable(),
      deckId: z.string().nullable(),
      slideCount: z.number(),
      /** True when this thread is the one doing a review. */
      isRunner: z.boolean(),
      /** What the runner is reviewing, for the panel heading. */
      reviewing: z.string().nullable(),
      canStartReview: z.boolean(),
      /** Set when the deck is linked to this thread rather than made by it. */
      attachedAs: z.string().nullable(),
      attachedDeckTitle: z.string().nullable(),
    }),
  },
});

// ---------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------

export default async function plugin(bb: BbPluginApi) {
  const db = bb.storage.database();

  /**
   * Schema setup that does not care what order it runs in.
   *
   * `bb.storage.migrate` keys each statement by its position in the array, so
   * inserting one in the middle silently shifts every later statement and a
   * column quietly never gets created. That happened here. Plain idempotent
   * DDL removes the whole class of bug: every statement is safe to run on
   * every load, on a new database and an old one alike.
   */
  function ensureColumn(table: string, column: string, type: string): void {
    // Names are literals from this file, never user input.
    const columns = db.prepare(`PRAGMA table_info(${table})`).all() as {
      name: string;
    }[];
    if (columns.some((entry) => entry.name === column)) return;
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
    bb.log.info(`added ${table}.${column}`);
  }

  db.exec(`
    CREATE TABLE IF NOT EXISTS decks (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      summary TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'draft',
      project_id TEXT,
      environment_id TEXT,
      thread_id TEXT,
      target TEXT NOT NULL DEFAULT '{"target":"uncommitted"}',
      shortstat TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS slides (
      id TEXT PRIMARY KEY,
      deck_id TEXT NOT NULL,
      position INTEGER NOT NULL,
      title TEXT NOT NULL,
      kind TEXT NOT NULL DEFAULT 'change',
      summary TEXT NOT NULL DEFAULT '',
      why TEXT,
      files TEXT NOT NULL DEFAULT '[]',
      annotations TEXT NOT NULL DEFAULT '[]',
      suggestions TEXT NOT NULL DEFAULT '[]',
      diagram TEXT
    );
    CREATE TABLE IF NOT EXISTS slide_state (
      slide_id TEXT PRIMARY KEY,
      deck_id TEXT NOT NULL,
      state TEXT NOT NULL DEFAULT 'pending',
      note TEXT NOT NULL DEFAULT '',
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS annotation_verdict (
      annotation_id TEXT PRIMARY KEY,
      deck_id TEXT NOT NULL,
      verdict TEXT NOT NULL DEFAULT 'open',
      note TEXT NOT NULL DEFAULT '',
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS watches (
      id TEXT PRIMARY KEY,
      url TEXT NOT NULL UNIQUE,
      hostname TEXT NOT NULL,
      project_path TEXT NOT NULL,
      iid INTEGER NOT NULL,
      title TEXT NOT NULL DEFAULT '',
      target_branch TEXT NOT NULL DEFAULT '',
      mr_state TEXT NOT NULL DEFAULT '',
      draft INTEGER NOT NULL DEFAULT 0,
      bb_project_id TEXT,
      prompt TEXT NOT NULL DEFAULT '',
      enabled INTEGER NOT NULL DEFAULT 1,
      deck_id TEXT,
      last_sha TEXT,
      head_sha TEXT,
      state TEXT NOT NULL DEFAULT 'idle',
      last_error TEXT,
      run_thread_id TEXT,
      run_sha TEXT,
      run_started_at TEXT,
      last_checked_at TEXT,
      last_reviewed_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS thread_runs (
      run_thread_id TEXT PRIMARY KEY,
      source_thread_id TEXT NOT NULL,
      started_at TEXT NOT NULL
    );
    -- The previous version of a deck, held while it is being rewritten so a
    -- review that dies half way through cannot destroy a deck you already read.
    -- Threads a deck is about beyond the three it owns columns for: the
    -- thread opened to fix its findings, and any thread you attach by hand.
    CREATE TABLE IF NOT EXISTS deck_threads (
      deck_id TEXT NOT NULL,
      thread_id TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'attached',
      created_at TEXT NOT NULL,
      PRIMARY KEY (deck_id, thread_id)
    );
    CREATE TABLE IF NOT EXISTS slides_backup (
      id TEXT PRIMARY KEY,
      deck_id TEXT NOT NULL,
      position INTEGER NOT NULL,
      title TEXT NOT NULL,
      kind TEXT NOT NULL,
      summary TEXT NOT NULL,
      why TEXT,
      files TEXT NOT NULL,
      annotations TEXT NOT NULL,
      suggestions TEXT NOT NULL,
      diagram TEXT,
      patch_cache TEXT
    );
  `);

  ensureColumn("watches", "failed_sha", "TEXT");
  ensureColumn("watches", "failure_count", "INTEGER NOT NULL DEFAULT 0");
  ensureColumn("decks", "watch_id", "TEXT");
  ensureColumn("decks", "source_thread_id", "TEXT");
  ensureColumn("decks", "discussion_thread_id", "TEXT");
  ensureColumn("slides", "patch_cache", "TEXT");
  ensureColumn("slide_state", "content_key", "TEXT");
  ensureColumn("annotation_verdict", "content_key", "TEXT");

  db.exec(`
    CREATE INDEX IF NOT EXISTS slides_by_deck ON slides (deck_id, position);
    CREATE INDEX IF NOT EXISTS verdict_by_content
      ON annotation_verdict (deck_id, content_key);
    CREATE INDEX IF NOT EXISTS slide_state_by_content
      ON slide_state (deck_id, content_key);
    CREATE INDEX IF NOT EXISTS thread_runs_by_source
      ON thread_runs (source_thread_id);
    CREATE INDEX IF NOT EXISTS deck_threads_by_thread
      ON deck_threads (thread_id);
  `);

  const settings = bb.settings.define({
    defaultTarget: {
      type: "select",
      label: "Which diff a new deck reviews",
      options: ["branch and uncommitted", "branch only", "uncommitted only"],
      default: "branch and uncommitted",
    },
    keepDecks: {
      type: "string",
      label: "Decks to keep per project (older ones are deleted)",
      default: "20",
    },
    pollMinutes: {
      type: "string",
      label: "Minutes between checks for new commits on watched merge requests",
      default: "5",
    },
    autoReview: {
      type: "boolean",
      label: "Re-review a watched merge request when it gets new commits",
      default: true,
    },
    reviewDraftMrs: {
      type: "boolean",
      label: "Also review merge requests marked as draft",
      default: false,
    },
    hideReviewThreads: {
      type: "boolean",
      label: "Keep review threads out of the sidebar",
      default: true,
    },
    reviewProject: {
      type: "project",
      label:
        "Prefer this project for merge request reviews (it must have the same repository)",
    },
    defaultPrompt: {
      type: "string",
      label: "Default review prompt (a watch can override it)",
      experimental_multiline: true,
      default: DEFAULT_REVIEW_PROMPT,
    },
  });

  function now(): string {
    return new Date().toISOString();
  }

  function changed(): void {
    bb.realtime.publish(DECKS_CHANGED, { at: Date.now() });
  }

  // -------------------------------------------------------------------------
  // Reading
  // -------------------------------------------------------------------------

  function readDeckRow(deckId: string): DeckRow | null {
    const row = db.prepare(`SELECT * FROM decks WHERE id = ?`).get(deckId) as
      | DeckRow
      | undefined;
    return row ?? null;
  }

  function readSlideRows(deckId: string): SlideRow[] {
    return db
      .prepare(`SELECT * FROM slides WHERE deck_id = ? ORDER BY position ASC`)
      .all(deckId) as SlideRow[];
  }

  function readSlideStates(deckId: string): Map<string, SlideStateRow> {
    const rows = db
      .prepare(`SELECT slide_id, state, note FROM slide_state WHERE deck_id = ?`)
      .all(deckId) as SlideStateRow[];
    return new Map(rows.map((row) => [row.slide_id, row]));
  }

  function readVerdicts(deckId: string): VerdictRow[] {
    return db
      .prepare(
        `SELECT annotation_id, verdict, note FROM annotation_verdict WHERE deck_id = ?`,
      )
      .all(deckId) as VerdictRow[];
  }

  function toSlide(row: SlideRow, states: Map<string, SlideStateRow>): Slide {
    const state = states.get(row.id);
    const annotations = parseJson<Annotation[]>(row.annotations, []);
    annotations.sort(
      (a, b) =>
        (SEVERITY_ORDER[a.severity] ?? 9) - (SEVERITY_ORDER[b.severity] ?? 9),
    );
    return {
      id: row.id,
      position: row.position,
      title: row.title,
      kind: slideKindSchema.catch("change").parse(row.kind),
      summary: row.summary,
      why: row.why,
      files: parseJson<SlideFile[]>(row.files, []),
      annotations,
      suggestions: parseJson<Suggestion[]>(row.suggestions, []),
      diagram: parseJson<Diagram | null>(row.diagram, null),
      state: (state?.state as ReviewState | undefined) ?? "pending",
      note: state?.note ?? "",
    };
  }

  function summarise(row: DeckRow): DeckSummary {
    const counts = db
      .prepare(`SELECT COUNT(*) AS n FROM slides WHERE deck_id = ?`)
      .get(row.id) as { n: number };
    const slides = readSlideRows(row.id);
    const states = readSlideStates(row.id);
    let annotationCount = 0;
    let blockerCount = 0;
    for (const slide of slides) {
      const annotations = parseJson<Annotation[]>(slide.annotations, []);
      annotationCount += annotations.length;
      blockerCount += annotations.filter(
        (item) => item.severity === "blocker",
      ).length;
    }
    let approvedCount = 0;
    let needsWorkCount = 0;
    for (const slide of slides) {
      const state = states.get(slide.id)?.state;
      if (state === "approved") approvedCount += 1;
      if (state === "needs-work") needsWorkCount += 1;
    }
    return {
      id: row.id,
      title: row.title,
      summary: row.summary,
      status: row.status === "ready" ? "ready" : "draft",
      projectId: row.project_id,
      environmentId: row.environment_id,
      threadId: row.thread_id,
      shortstat: row.shortstat,
      slideCount: counts.n,
      annotationCount,
      blockerCount,
      approvedCount,
      needsWorkCount,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  function readDeck(deckId: string): Deck | null {
    const row = readDeckRow(deckId);
    if (row === null) return null;
    const states = readSlideStates(deckId);
    const verdicts: Deck["verdicts"] = {};
    for (const verdict of readVerdicts(deckId)) {
      verdicts[verdict.annotation_id] = {
        verdict: verdict.verdict as Deck["verdicts"][string]["verdict"],
        note: verdict.note,
      };
    }
    return {
      ...summarise(row),
      target: parseJson<DiffTarget>(row.target, { target: "uncommitted" }),
      slides: readSlideRows(deckId).map((slide) => toSlide(slide, states)),
      verdicts,
    };
  }

  function listDecks(projectId?: string | null): DeckSummary[] {
    const rows = (
      projectId === undefined || projectId === null
        ? db.prepare(`SELECT * FROM decks ORDER BY created_at DESC`).all()
        : db
            .prepare(
              `SELECT * FROM decks WHERE project_id = ? ORDER BY created_at DESC`,
            )
            .all(projectId)
    ) as DeckRow[];
    return rows.map(summarise);
  }

  // -------------------------------------------------------------------------
  // Writing
  // -------------------------------------------------------------------------

  function deleteDeck(deckId: string): boolean {
    const result = db.prepare(`DELETE FROM decks WHERE id = ?`).run(deckId);
    db.prepare(`DELETE FROM slides_backup WHERE deck_id = ?`).run(deckId);
    db.prepare(`DELETE FROM deck_threads WHERE deck_id = ?`).run(deckId);
    db.prepare(`UPDATE watches SET deck_id = NULL WHERE deck_id = ?`).run(deckId);
    db.prepare(`DELETE FROM slides WHERE deck_id = ?`).run(deckId);
    db.prepare(`DELETE FROM slide_state WHERE deck_id = ?`).run(deckId);
    db.prepare(`DELETE FROM annotation_verdict WHERE deck_id = ?`).run(deckId);
    if (result.changes > 0) changed();
    return result.changes > 0;
  }

  /** Keep the newest N decks per project so the store cannot grow forever. */
  async function pruneDecks(projectId: string | null): Promise<void> {
    const { keepDecks } = await settings.get();
    const keep = Number.parseInt(keepDecks, 10);
    if (!Number.isFinite(keep) || keep < 1) return;
    // A watched merge request's deck is the thing its link points at, so it is
    // never pruned however old it gets.
    const stale = (
      projectId === null
        ? db
            .prepare(
              `SELECT id FROM decks
               WHERE project_id IS NULL AND watch_id IS NULL AND source_thread_id IS NULL
               ORDER BY created_at DESC LIMIT -1 OFFSET ?`,
            )
            .all(keep)
        : db
            .prepare(
              `SELECT id FROM decks
               WHERE project_id = ? AND watch_id IS NULL AND source_thread_id IS NULL
               ORDER BY created_at DESC LIMIT -1 OFFSET ?`,
            )
            .all(projectId, keep)
    ) as { id: string }[];
    for (const row of stale) deleteDeck(row.id);
  }

  function insertSlide(deckId: string, input: SlideInput): Slide {
    const slideId = `sl_${randomUUID().slice(0, 12)}`;
    const next = db
      .prepare(
        `SELECT COALESCE(MAX(position), 0) + 1 AS position FROM slides WHERE deck_id = ?`,
      )
      .get(deckId) as { position: number };
    const annotations: Annotation[] = input.annotations.map(
      (annotation, index) => ({ ...annotation, id: `${slideId}-a${index + 1}` }),
    );
    db.prepare(
      `INSERT INTO slides
         (id, deck_id, position, title, kind, summary, why, files, annotations, suggestions, diagram)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      slideId,
      deckId,
      next.position,
      input.title,
      input.kind,
      input.summary,
      input.why ?? null,
      JSON.stringify(input.files),
      JSON.stringify(annotations),
      JSON.stringify(input.suggestions),
      input.diagram === null || input.diagram === undefined
        ? null
        : JSON.stringify(input.diagram),
    );
    // A re-review deletes the old slides, so any mark the reviewer already
    // made is re-pointed at the finding that replaced it.
    const slideContentKey = slideKey(input.title);
    // Read the old mark before deleting it — the row being replaced is the one
    // holding the answer that has to be carried over.
    const carriedSlide = db
      .prepare(
        `SELECT state, note FROM slide_state WHERE deck_id = ? AND content_key = ?`,
      )
      .get(deckId, slideContentKey) as
      | { state: string; note: string }
      | undefined;
    db.prepare(
      `DELETE FROM slide_state WHERE deck_id = ? AND content_key = ? AND slide_id != ?`,
    ).run(deckId, slideContentKey, slideId);
    if (carriedSlide !== undefined) {
      db.prepare(
        `INSERT OR REPLACE INTO slide_state (slide_id, deck_id, state, note, updated_at, content_key)
         VALUES (?, ?, ?, ?, ?, ?)`,
      ).run(
        slideId,
        deckId,
        carriedSlide.state,
        carriedSlide.note,
        now(),
        slideContentKey,
      );
    }
    for (const annotation of annotations) {
      const key = annotationKey(annotation.path, annotation.title);
      const carried = db
        .prepare(
          `SELECT verdict, note FROM annotation_verdict WHERE deck_id = ? AND content_key = ?`,
        )
        .get(deckId, key) as { verdict: string; note: string } | undefined;
      if (carried === undefined) continue;
      db.prepare(
        `DELETE FROM annotation_verdict WHERE deck_id = ? AND content_key = ?`,
      ).run(deckId, key);
      db.prepare(
        `INSERT OR REPLACE INTO annotation_verdict
           (annotation_id, deck_id, verdict, note, updated_at, content_key)
         VALUES (?, ?, ?, ?, ?, ?)`,
      ).run(annotation.id, deckId, carried.verdict, carried.note, now(), key);
    }
    db.prepare(`UPDATE decks SET updated_at = ? WHERE id = ?`).run(now(), deckId);
    changed();
    return {
      id: slideId,
      position: next.position,
      title: input.title,
      kind: input.kind,
      summary: input.summary,
      why: input.why ?? null,
      files: input.files,
      annotations,
      suggestions: input.suggestions,
      diagram: input.diagram ?? null,
      state: "pending",
      note: "",
    };
  }

  // -------------------------------------------------------------------------
  // Resolving the change under review
  // -------------------------------------------------------------------------

  /** The environment a thread is working in, when it has one. */
  async function environmentForThread(
    threadId: string | undefined,
  ): Promise<{ environmentId: string | null; projectId: string | null }> {
    if (threadId === undefined) return { environmentId: null, projectId: null };
    try {
      const thread = await bb.sdk.threads.get({ threadId });
      return {
        environmentId: thread.environmentId,
        projectId: thread.projectId,
      };
    } catch {
      return { environmentId: null, projectId: null };
    }
  }

  /** The diff a new deck should review, honouring the plugin setting. */
  async function defaultTarget(
    environmentId: string | null,
  ): Promise<DiffTarget> {
    const { defaultTarget: preference } = await settings.get();
    if (preference === "uncommitted only" || environmentId === null) {
      return { target: "uncommitted" };
    }
    let base: string | null = null;
    try {
      const environment = await bb.sdk.environments.get({ environmentId });
      base =
        environment.mergeBaseBranch ??
        environment.baseBranch ??
        environment.defaultBranch;
    } catch {
      base = null;
    }
    if (base === null || base === "") return { target: "uncommitted" };
    return preference === "branch only"
      ? { target: "branch_committed", mergeBaseBranch: base }
      : { target: "all", mergeBaseBranch: base };
  }

  /**
   * `diffFiles` takes the target spread flat; `diffPatch` takes it nested under
   * a `type` key. Same target, two shapes on the wire.
   */
  function nestTarget(target: DiffTarget) {
    switch (target.target) {
      case "branch_committed":
        return {
          type: "branch_committed" as const,
          mergeBaseBranch: target.mergeBaseBranch,
        };
      case "all":
        return { type: "all" as const, mergeBaseBranch: target.mergeBaseBranch };
      case "commit":
        return { type: "commit" as const, sha: target.sha };
      default:
        return { type: "uncommitted" as const };
    }
  }

  interface ChangedFile {
    path: string;
    previousPath: string | null;
    changeKind: string;
    additions: number;
    deletions: number;
    binary: boolean;
  }

  interface ChangedFiles {
    ok: boolean;
    message: string;
    shortstat: string;
    files: ChangedFile[];
    patches: Map<string, { patch: string; truncated: boolean }>;
  }

  async function readChangedFiles(
    environmentId: string,
    target: DiffTarget,
  ): Promise<ChangedFiles> {
    const empty: ChangedFiles = {
      ok: false,
      message: "",
      shortstat: "",
      files: [],
      patches: new Map(),
    };
    let result;
    try {
      result = await bb.sdk.environments.diffFiles({ environmentId, ...target });
    } catch (cause) {
      return {
        ...empty,
        message: cause instanceof Error ? cause.message : String(cause),
      };
    }
    if (result.outcome === "not_applicable") {
      return { ...empty, message: result.message };
    }
    if (result.outcome === "unavailable") {
      return { ...empty, message: result.failure.message };
    }
    return {
      ok: true,
      message: "",
      shortstat: result.shortstat,
      files: result.files.map((file) => ({
        path: file.path,
        previousPath: file.previousPath,
        changeKind: file.changeKind,
        additions: file.additions,
        deletions: file.deletions,
        binary: file.binary,
      })),
      patches: new Map(
        result.initialPatches.map((entry) => [
          entry.path,
          { patch: entry.patch, truncated: entry.truncated },
        ]),
      ),
    };
  }

  /**
   * The patches a slide needs. A slide may carry its own patch text; anything
   * else is read from the environment's real diff so the deck never drifts
   * from the code.
   */
  async function resolvePatches(
    deck: Deck,
    slide: Slide,
  ): Promise<ResolvedPatch[]> {
    const resolved: ResolvedPatch[] = [];
    const wanted: string[] = [];
    for (const file of slide.files) {
      if (typeof file.patch === "string" && file.patch.trim() !== "") continue;
      wanted.push(file.path);
    }

    const fetched = new Map<string, { patch: string; truncated: boolean }>();
    let fetchError: string | null = null;
    if (wanted.length > 0) {
      if (deck.environmentId === null) {
        fetchError = "This deck is not linked to a workspace, so BB cannot read the diff.";
      } else {
        try {
          const result = await bb.sdk.environments.diffPatch({
            environmentId: deck.environmentId,
            target: nestTarget(deck.target),
            paths: wanted,
          });
          if (result.outcome === "available") {
            for (const entry of result.patches) {
              fetched.set(entry.path, {
                patch: entry.patch,
                truncated: entry.truncated,
              });
            }
          } else if (result.outcome === "not_applicable") {
            fetchError = result.message;
          } else {
            fetchError = result.failure.message;
          }
        } catch (cause) {
          fetchError = cause instanceof Error ? cause.message : String(cause);
        }
      }
    }

    for (const file of slide.files) {
      const own = typeof file.patch === "string" ? file.patch.trim() : "";
      if (own !== "") {
        resolved.push({
          path: file.path,
          previousPath: file.previousPath ?? null,
          role: file.role ?? null,
          patch: own.slice(0, MAX_PATCH_BYTES),
          truncated: own.length > MAX_PATCH_BYTES,
          source: "slide",
          error: null,
        });
        continue;
      }
      const hit = fetched.get(file.path);
      if (hit !== undefined) {
        resolved.push({
          path: file.path,
          previousPath: file.previousPath ?? null,
          role: file.role ?? null,
          patch: hit.patch,
          truncated: hit.truncated,
          source: "environment",
          error: null,
        });
        continue;
      }
      // The live read failed. A merge-request review runs in a throwaway
      // worktree that is retired when the run ends, so fall back to the copy
      // taken while that worktree still existed.
      const cached = readPatchCache(slide.id).get(file.path);
      resolved.push({
        path: file.path,
        previousPath: file.previousPath ?? null,
        role: file.role ?? null,
        patch: cached?.patch ?? "",
        truncated: cached?.truncated ?? false,
        source: cached === undefined ? "environment" : "snapshot",
        error:
          cached !== undefined
            ? null
            : (fetchError ??
              "No diff for this file. It may be unchanged, binary, or outside the diff range."),
      });
    }
    return resolved;
  }

  interface CachedPatch {
    patch: string;
    truncated: boolean;
  }

  function readPatchCache(slideId: string): Map<string, CachedPatch> {
    const row = db
      .prepare(`SELECT patch_cache FROM slides WHERE id = ?`)
      .get(slideId) as { patch_cache: string | null } | undefined;
    const entries = parseJson<(CachedPatch & { path: string })[]>(
      row?.patch_cache ?? null,
      [],
    );
    return new Map(
      entries.map((entry) => [
        entry.path,
        { patch: entry.patch, truncated: entry.truncated },
      ]),
    );
  }

  /**
   * Copies each slide's diff into the deck while the workspace still exists.
   * Without this a finished merge-request review is a set of findings with no
   * code under them, because its worktree is retired with the worker thread.
   */
  async function snapshotPatches(deckId: string): Promise<void> {
    const deck = readDeck(deckId);
    if (deck === null) return;
    for (const slide of deck.slides) {
      if (slide.files.length === 0) continue;
      let patches;
      try {
        patches = await resolvePatches(deck, slide);
      } catch {
        continue;
      }
      const keep = patches
        .filter((entry) => entry.patch !== "")
        .map((entry) => ({
          path: entry.path,
          patch: entry.patch,
          truncated: entry.truncated,
        }));
      if (keep.length === 0) continue;
      db.prepare(`UPDATE slides SET patch_cache = ? WHERE id = ?`).run(
        JSON.stringify(keep),
        slide.id,
      );
    }
  }

  // -------------------------------------------------------------------------
  // Reviewer notes
  // -------------------------------------------------------------------------

  const stateLabel: Record<ReviewState, string> = {
    pending: "not reviewed",
    approved: "looks good",
    "needs-work": "needs work",
  };

  function notesMarkdown(deck: Deck): string {
    const lines: string[] = [];
    lines.push(`# Review notes — ${deck.title}`);
    lines.push("");
    const approved = deck.slides.filter((s) => s.state === "approved").length;
    const needsWork = deck.slides.filter((s) => s.state === "needs-work");
    lines.push(
      `${approved} of ${deck.slides.length} slides look good; ` +
        `${needsWork.length} ${needsWork.length === 1 ? "needs" : "need"} work.`,
    );
    lines.push("");
    for (const slide of deck.slides) {
      const replies = slide.annotations
        .map((annotation) => ({
          annotation,
          reply: deck.verdicts[annotation.id],
        }))
        .filter(
          (entry) =>
            entry.reply !== undefined && entry.reply.verdict !== "open",
        );
      if (
        slide.state === "pending" &&
        slide.note.trim() === "" &&
        replies.length === 0
      ) {
        continue;
      }
      lines.push(
        `## Slide ${slide.position} — ${slide.title} (${stateLabel[slide.state]})`,
      );
      if (slide.note.trim() !== "") {
        lines.push("");
        lines.push(slide.note.trim());
      }
      for (const { annotation, reply } of replies) {
        lines.push("");
        lines.push(
          `- **${reply?.verdict === "accepted" ? "Agreed" : "Disagreed"}** — ` +
            `${annotation.severity.toUpperCase()} \`${annotation.path}:${annotation.line}\` — ${annotation.title}`,
        );
        if ((reply?.note ?? "").trim() !== "") {
          lines.push(`  - Reviewer: ${reply?.note.trim()}`);
        }
      }
      lines.push("");
    }
    if (lines.length <= 4) {
      lines.push("_No slide has been marked or replied to yet._");
    }
    return lines.join("\n");
  }

  // -------------------------------------------------------------------------
  // Keeping the reviewer's marks across a re-review
  // -------------------------------------------------------------------------

  /**
   * Stamps every existing mark with what it was about, just before the slides
   * that carry those ids are deleted. Marks made before this plugin knew about
   * content keys are stamped here too.
   */
  function rememberVerdictKeys(deckId: string): void {
    const deck = readDeck(deckId);
    if (deck === null) return;
    for (const slide of deck.slides) {
      db.prepare(
        `UPDATE slide_state SET content_key = ? WHERE slide_id = ? AND deck_id = ?`,
      ).run(slideKey(slide.title), slide.id, deckId);
      for (const annotation of slide.annotations) {
        db.prepare(
          `UPDATE annotation_verdict SET content_key = ? WHERE annotation_id = ? AND deck_id = ?`,
        ).run(annotationKey(annotation.path, annotation.title), annotation.id, deckId);
      }
    }
  }

  /** Puts the current slides aside before a rewrite replaces them. */
  function backUpSlides(deckId: string): void {
    db.prepare(`DELETE FROM slides_backup WHERE deck_id = ?`).run(deckId);
    db.prepare(
      `INSERT INTO slides_backup
         (id, deck_id, position, title, kind, summary, why, files, annotations,
          suggestions, diagram, patch_cache)
       SELECT id, deck_id, position, title, kind, summary, why, files, annotations,
              suggestions, diagram, patch_cache
       FROM slides WHERE deck_id = ?`,
    ).run(deckId);
  }

  function discardBackup(deckId: string): void {
    db.prepare(`DELETE FROM slides_backup WHERE deck_id = ?`).run(deckId);
  }

  /**
   * Puts the previous deck back. Called when a review run ends without ever
   * finishing its deck — an interrupted rewrite would otherwise leave half a
   * deck where a complete one used to be.
   */
  function restoreBackup(deckId: string): boolean {
    const held = db
      .prepare(`SELECT COUNT(*) AS n FROM slides_backup WHERE deck_id = ?`)
      .get(deckId) as { n: number };
    if (held.n === 0) return false;
    db.prepare(`DELETE FROM slides WHERE deck_id = ?`).run(deckId);
    db.prepare(
      `INSERT INTO slides
         (id, deck_id, position, title, kind, summary, why, files, annotations,
          suggestions, diagram, patch_cache)
       SELECT id, deck_id, position, title, kind, summary, why, files, annotations,
              suggestions, diagram, patch_cache
       FROM slides_backup WHERE deck_id = ?`,
    ).run(deckId);
    discardBackup(deckId);
    db.prepare(`UPDATE decks SET status = 'ready', updated_at = ? WHERE id = ?`).run(
      now(),
      deckId,
    );
    changed();
    return true;
  }

  /** Forgets marks whose finding did not come back in the new review. */
  function dropOrphanedMarks(deckId: string): void {
    const deck = readDeck(deckId);
    if (deck === null) return;
    const liveAnnotations = new Set(
      deck.slides.flatMap((slide) => slide.annotations.map((item) => item.id)),
    );
    const liveSlides = new Set(deck.slides.map((slide) => slide.id));
    for (const row of db
      .prepare(`SELECT annotation_id FROM annotation_verdict WHERE deck_id = ?`)
      .all(deckId) as { annotation_id: string }[]) {
      if (liveAnnotations.has(row.annotation_id)) continue;
      db.prepare(`DELETE FROM annotation_verdict WHERE annotation_id = ?`).run(
        row.annotation_id,
      );
    }
    for (const row of db
      .prepare(`SELECT slide_id FROM slide_state WHERE deck_id = ?`)
      .all(deckId) as { slide_id: string }[]) {
      if (liveSlides.has(row.slide_id)) continue;
      db.prepare(`DELETE FROM slide_state WHERE slide_id = ?`).run(row.slide_id);
    }
  }

  // -------------------------------------------------------------------------
  // Watched merge requests
  // -------------------------------------------------------------------------

  interface WatchRow {
    id: string;
    url: string;
    hostname: string;
    project_path: string;
    iid: number;
    title: string;
    target_branch: string;
    mr_state: string;
    draft: number;
    bb_project_id: string | null;
    prompt: string;
    enabled: number;
    deck_id: string | null;
    last_sha: string | null;
    head_sha: string | null;
    state: string;
    last_error: string | null;
    run_thread_id: string | null;
    run_sha: string | null;
    run_started_at: string | null;
    last_checked_at: string | null;
    last_reviewed_at: string | null;
    created_at: string;
    failed_sha: string | null;
    failure_count: number;
  }

  /** The merge-request fields the watcher reads from GitLab. */
  interface MergeRequest {
    iid: number;
    title: string;
    description: string;
    state: string;
    draft: boolean;
    sha: string;
    sourceBranch: string;
    targetBranch: string;
    webUrl: string;
  }

  const runExecFile = promisify(execFile);

  /**
   * The glab binary. Overridable so the test suite can point at a stub and
   * stay offline, and so anyone whose glab is not on PATH can name it.
   */
  const GLAB = process.env.BB_REVIEW_DECK_GLAB ?? "glab";

  /**
   * Calls the GitLab REST API through `glab`, reusing the login the user
   * already has. `glab api` is a thin pass-through, so this needs no token of
   * its own. The command runs on the BB server, so glab must be installed and
   * authenticated there.
   */
  async function glabApi<T>(hostname: string, path: string): Promise<T> {
    try {
      const { stdout } = await runExecFile(
        GLAB,
        ["api", "--hostname", hostname, path],
        { maxBuffer: 8 * 1024 * 1024, timeout: 30_000 },
      );
      return JSON.parse(stdout) as T;
    } catch (cause) {
      const error = cause as { code?: string; stderr?: string; message?: string };
      if (error.code === "ENOENT") {
        throw new Error(
          `${GLAB} is not installed on the BB server. Install it and run \`glab auth login\`.`,
        );
      }
      const detail = (error.stderr ?? error.message ?? "").trim();
      throw new Error(
        detail === "" ? `glab call failed for ${path}` : detail.split("\n")[0]!,
      );
    }
  }

  async function readMergeRequest(ref: MergeRequestRef): Promise<MergeRequest> {
    const encoded = encodeURIComponent(ref.projectPath);
    const raw = await glabApi<Record<string, unknown>>(
      ref.hostname,
      `projects/${encoded}/merge_requests/${ref.iid}`,
    );
    return {
      iid: Number(raw.iid ?? ref.iid),
      title: String(raw.title ?? ""),
      description: String(raw.description ?? ""),
      state: String(raw.state ?? ""),
      draft: raw.draft === true || raw.work_in_progress === true,
      sha: String(raw.sha ?? ""),
      sourceBranch: String(raw.source_branch ?? ""),
      targetBranch: String(raw.target_branch ?? ""),
      webUrl: String(raw.web_url ?? ""),
    };
  }

  /**
   * The BB project whose git remote points at this merge request's repo, plus
   * the machine its default source lives on — a managed worktree has to be cut
   * on a named host.
   */
  async function findProject(
    ref: MergeRequestRef,
    preferProjectId?: string | null,
  ): Promise<{ id: string; name: string; hostId: string | null } | null> {
    const wanted = remoteKey(ref).toLowerCase();
    let projects;
    try {
      projects = await bb.sdk.projects.list();
    } catch {
      return null;
    }
    const matching = projects.filter(
      (project) => normaliseRemote(project.gitRemoteUrl)?.toLowerCase() === wanted,
    );
    if (matching.length === 0) return null;
    // The review has to run where the repository is, because the worktree is
    // cut from the project's own source. A preferred project is honoured only
    // when it also has this repository; otherwise the one that does wins.
    const chosen =
      matching.find((project) => project.id === preferProjectId) ?? matching[0]!;
    const sources = chosen.sources ?? [];
    const source = sources.find((entry) => entry.isDefault) ?? sources[0];
    return {
      id: chosen.id,
      name: chosen.name,
      hostId: source?.hostId ?? null,
    };
  }

  const projectNames = new Map<string, string>();

  function toWatch(row: WatchRow): Watch {
    let deckSlideCount = 0;
    let deckFindingCount = 0;
    if (row.deck_id !== null) {
      for (const slide of db
        .prepare(`SELECT annotations FROM slides WHERE deck_id = ?`)
        .all(row.deck_id) as { annotations: string }[]) {
        deckSlideCount += 1;
        deckFindingCount += parseJson<unknown[]>(slide.annotations, []).length;
      }
    }
    return {
      runThreadId: row.run_thread_id,
      runStartedAt: row.run_started_at,
      deckSlideCount,
      deckFindingCount,
      id: row.id,
      url: row.url,
      hostname: row.hostname,
      projectPath: row.project_path,
      iid: row.iid,
      title: row.title,
      targetBranch: row.target_branch,
      mrState: row.mr_state,
      draft: row.draft === 1,
      bbProjectId: row.bb_project_id,
      bbProjectName:
        row.bb_project_id === null
          ? null
          : (projectNames.get(row.bb_project_id) ?? null),
      prompt: row.prompt,
      enabled: row.enabled === 1,
      deckId: row.deck_id,
      lastSha: row.last_sha,
      headSha: row.head_sha,
      state: (row.state as WatchState) ?? "idle",
      lastError: row.last_error,
      lastCheckedAt: row.last_checked_at,
      lastReviewedAt: row.last_reviewed_at,
      createdAt: row.created_at,
    };
  }

  function readWatchRow(watchId: string): WatchRow | null {
    return (
      (db.prepare(`SELECT * FROM watches WHERE id = ?`).get(watchId) as
        | WatchRow
        | undefined) ?? null
    );
  }

  function readWatchRows(): WatchRow[] {
    return db
      .prepare(`SELECT * FROM watches ORDER BY created_at DESC`)
      .all() as WatchRow[];
  }

  function watchChanged(): void {
    bb.realtime.publish(WATCHES_CHANGED, { at: Date.now() });
  }

  function setWatch(watchId: string, fields: Record<string, unknown>): void {
    const keys = Object.keys(fields);
    if (keys.length === 0) return;
    db.prepare(
      `UPDATE watches SET ${keys.map((key) => `${key} = ?`).join(", ")}, updated_at = ? WHERE id = ?`,
    ).run(...keys.map((key) => fields[key]), now(), watchId);
    watchChanged();
  }

  /** Fills in bbProjectName for the rows the frontend is about to see. */
  async function loadProjectNames(rows: WatchRow[]): Promise<void> {
    if (rows.every((row) => row.bb_project_id === null)) return;
    try {
      for (const project of await bb.sdk.projects.list()) {
        projectNames.set(project.id, project.name);
      }
    } catch {
      /* names are cosmetic */
    }
  }

  /**
   * The prompt the review agent is given. It checks out the merge request head
   * itself, so the worktree can be cut from the default branch and never has
   * to guess at a branch name that may live on a fork.
   */
  function reviewPrompt(row: WatchRow, mr: MergeRequest, prompt: string): string {
    return [
      `Review merge request !${mr.iid} of ${row.project_path}: ${mr.title}`,
      row.url,
      "",
      "First, put the merge request in the working tree:",
      "",
      "```sh",
      `git fetch origin "merge-requests/${mr.iid}/head:mr-${mr.iid}"`,
      `git switch mr-${mr.iid}`,
      "```",
      "",
      "Then follow the review-deck skill and publish a review deck. Use this",
      "diff target for review_deck_changed_files and review_deck_create:",
      "",
      "```json",
      JSON.stringify({
        target: "all",
        mergeBaseBranch: `origin/${mr.targetBranch}`,
      }),
      "```",
      "",
      "Finish by calling review_deck_finish. Do not post anything to GitLab.",
      "",
      "---",
      "",
      prompt.trim(),
      ...(mr.description.trim() === ""
        ? []
        : [
            "",
            "---",
            "",
            "The author's description of the merge request:",
            "",
            mr.description.trim().slice(0, 4000),
          ]),
    ].join("\n");
  }

  /**
   * Takes the run slot for this watch, or reports that someone else has it.
   *
   * The claim is one UPDATE guarded on the slot being free. Checking first and
   * writing later would let two clicks on "Review now" both get through and
   * spawn two agents onto the same deck, which is exactly what happened before
   * this existed.
   */
  function claimRun(watchId: string): boolean {
    const row = readWatchRow(watchId);
    if (row === null) return false;
    if (row.run_started_at !== null) {
      const started = Date.parse(row.run_started_at);
      if (!Number.isFinite(started) || Date.now() - started <= RUN_TIMEOUT_MS) {
        return false;
      }
      // The previous run is long past its deadline; take the slot back.
      db.prepare(
        `UPDATE watches SET run_thread_id = NULL, run_sha = NULL, run_started_at = NULL,
                            state = 'error', last_error = ?
         WHERE id = ?`,
      ).run("The previous review did not finish in time.", watchId);
    }
    const claimed = db
      .prepare(
        `UPDATE watches SET run_started_at = ?, state = 'running', last_error = NULL, updated_at = ?
         WHERE id = ? AND run_started_at IS NULL`,
      )
      .run(now(), now(), watchId);
    if (claimed.changes === 0) return false;
    watchChanged();
    return true;
  }

  function releaseRun(watchId: string, error: string | null): void {
    db.prepare(
      `UPDATE watches SET run_thread_id = NULL, run_sha = NULL, run_started_at = NULL,
                          state = ?, last_error = ?, updated_at = ?
       WHERE id = ?`,
    ).run(error === null ? "idle" : "error", error, now(), watchId);
    watchChanged();
  }

  /** True when a run currently holds this watch's slot. */
  function runInFlight(row: WatchRow): boolean {
    if (row.run_started_at === null) return false;
    const started = Date.parse(row.run_started_at);
    return !Number.isFinite(started) || Date.now() - started <= RUN_TIMEOUT_MS;
  }

  /**
   * Starts one review. Returns a sentence explaining what happened, which the
   * UI and the CLI both show.
   */
  async function startReview(
    watchId: string,
    options: { force?: boolean } = {},
  ): Promise<{ started: boolean; message: string }> {
    const row = readWatchRow(watchId);
    if (row === null) return { started: false, message: "No such watch." };
    if (!claimRun(watchId)) {
      return { started: false, message: "A review is already running." };
    }

    const ref: MergeRequestRef = {
      hostname: row.hostname,
      projectPath: row.project_path,
      iid: row.iid,
    };
    let mr: MergeRequest;
    try {
      mr = await readMergeRequest(ref);
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      setWatch(watchId, { last_checked_at: now() });
      releaseRun(watchId, message);
      return { started: false, message };
    }

    const { reviewDraftMrs, defaultPrompt, hideReviewThreads, reviewProject } =
      await settings.get();
    setWatch(watchId, {
      title: mr.title,
      target_branch: mr.targetBranch,
      mr_state: mr.state,
      draft: mr.draft ? 1 : 0,
      head_sha: mr.sha,
      last_checked_at: now(),
    });

    if (mr.state !== "opened" && options.force !== true) {
      const message = `The merge request is ${mr.state}.`;
      releaseRun(watchId, null);
      return { started: false, message };
    }
    if (mr.draft && !reviewDraftMrs && options.force !== true) {
      const message =
        "The merge request is a draft. Turn on draft reviews to include it.";
      releaseRun(watchId, null);
      return { started: false, message };
    }

    const project = await findProject(ref, reviewProject);
    if (project === null) {
      const message =
        `No BB project has ${remoteKey(ref)} as its git remote. ` +
        "Add that repository as a project, then run the review again.";
      releaseRun(watchId, message);
      return { started: false, message };
    }
    if (project.hostId === null) {
      const message = `The project ${project.name} has no source machine to build a worktree on.`;
      releaseRun(watchId, message);
      return { started: false, message };
    }
    if (row.bb_project_id !== project.id) {
      setWatch(watchId, { bb_project_id: project.id });
    }

    const prompt = row.prompt.trim() === "" ? defaultPrompt : row.prompt;
    let thread;
    try {
      thread = await bb.sdk.threads.spawn({
        projectId: project.id,
        // A throwaway worktree cut from the default branch, on the machine the
        // project's default source lives on. The agent fetches the merge
        // request into it, so nothing touches the user's own checkout.
        environment: {
          type: "host",
          hostId: project.hostId,
          workspace: {
            type: "managed-worktree",
            baseBranch: { kind: "default" },
          },
        },
        title: `Review !${mr.iid} — ${mr.title}`.slice(0, 120),
        visibility: hideReviewThreads ? "hidden" : "visible",
        prompt: reviewPrompt(row, mr, prompt),
      });
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      releaseRun(watchId, message);
      return { started: false, message };
    }

    setWatch(watchId, {
      state: "running",
      last_error: null,
      failed_sha: null,
      run_thread_id: thread.id,
      run_sha: mr.sha,
    });
    bb.log.info(`review started for ${row.url} in thread ${thread.id}`);
    return { started: true, message: `Reviewing !${mr.iid}…` };
  }

  /** Adds a watch and kicks off its first review. Shared by RPC and CLI. */
  async function addWatch(input: {
    url: string;
    prompt?: string;
  }): Promise<{ ok: boolean; watchId: string | null; message: string }> {
    const { url, prompt } = input;

    const ref = parseMergeRequestUrl(url);
    if (ref === null) {
      return {
        ok: false,
        watchId: null,
        message:
          "That is not a merge request link. It should look like https://gitlab.example.com/group/project/-/merge_requests/42",
      };
    }
    const canonical = `https://${ref.hostname}/${ref.projectPath}/-/merge_requests/${ref.iid}`;
    const existing = db
      .prepare(`SELECT id FROM watches WHERE url = ?`)
      .get(canonical) as { id: string } | undefined;
    if (existing !== undefined) {
      const again = await startReview(existing.id);
      return {
        ok: true,
        watchId: existing.id,
        message: `Already watching !${ref.iid}. ${again.message}`,
      };
    }

    let mr;
    try {
      mr = await readMergeRequest(ref);
    } catch (cause) {
      return {
        ok: false,
        watchId: null,
        message: cause instanceof Error ? cause.message : String(cause),
      };
    }
    const project = await findProject(ref);
    const watchId = `wt_${randomUUID().slice(0, 12)}`;
    const timestamp = now();
    db.prepare(
      `INSERT INTO watches
         (id, url, hostname, project_path, iid, title, target_branch, mr_state,
          draft, bb_project_id, prompt, enabled, state, head_sha,
          last_checked_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 'idle', ?, ?, ?, ?)`,
    ).run(
      watchId,
      canonical,
      ref.hostname,
      ref.projectPath,
      ref.iid,
      mr.title,
      mr.targetBranch,
      mr.state,
      mr.draft ? 1 : 0,
      project?.id ?? null,
      (prompt ?? "").trim(),
      mr.sha,
      timestamp,
      timestamp,
      timestamp,
    );
    watchChanged();
    const run = await startReview(watchId);
    return {
      ok: true,
      watchId,
      message:
        run.started
          ? `Watching !${ref.iid}. ${run.message}`
          : `Watching !${ref.iid}, but the review did not start: ${run.message}`,
    };
  }

  /** Releases the hidden worker thread once its run is over. */
  async function finishRun(row: WatchRow, error: string | null): Promise<void> {
    const threadId = row.run_thread_id;
    let outcome = error;
    if (row.deck_id !== null) {
      if (restoreBackup(row.deck_id)) {
        bb.log.info(`restored the previous deck for ${row.url}`);
        outcome ??=
          "The review was stopped before it finished. The deck you had is still here.";
      }
      // Archiving retires the worktree, so the diff has to be copied first.
      await snapshotPatches(row.deck_id);
    }
    const failures = outcome === null ? 0 : (row.failure_count ?? 0) + 1;
    const standDown = failures >= MAX_CONSECUTIVE_FAILURES;
    setWatch(row.id, {
      state: outcome === null ? "idle" : "error",
      last_error:
        outcome === null
          ? null
          : standDown
            ? `${outcome} Paused after ${failures} attempts in a row — press Review now when you are ready.`
            : outcome,
      // Only a completed review records the commit as reviewed. Otherwise the
      // next sweep would skip a merge request nobody has actually reviewed.
      last_sha: outcome === null ? row.run_sha : row.last_sha,
      last_reviewed_at: outcome === null ? now() : row.last_reviewed_at,
      // The commit that did not get reviewed, so the sweep leaves it alone.
      failed_sha: outcome === null ? null : row.run_sha,
      failure_count: failures,
      enabled: standDown ? 0 : row.enabled,
      run_thread_id: null,
      run_sha: null,
      run_started_at: null,
    });
    if (threadId === null) return;
    try {
      await bb.sdk.threads.archive({ threadId });
    } catch {
      /* the thread may already be gone */
    }
    try {
      await bb.sdk.threads.stop({ threadId });
    } catch {
      /* stopping an idle runtime is a no-op */
    }
  }

  function watchForThread(threadId: string): WatchRow | null {
    return (
      (db.prepare(`SELECT * FROM watches WHERE run_thread_id = ?`).get(threadId) as
        | WatchRow
        | undefined) ?? null
    );
  }

  /**
   * Why a run ended, or null when it genuinely completed.
   *
   * Completion means the agent called review_deck_finish, which is the only
   * thing that marks a deck `ready`. "Has some slides" is not enough: a review
   * stopped part way through a rewrite leaves a partial deck, and treating
   * that as success would record the merge request as reviewed at this commit
   * and stop it ever being picked up again.
   */
  function runOutcome(row: WatchRow): string | null {
    if (row.deck_id === null) {
      return "The review ended without starting a deck. Open the thread to see why.";
    }
    const deck = readDeckRow(row.deck_id);
    if (deck === null) {
      return "The review ended without starting a deck. Open the thread to see why.";
    }
    if (deck.status !== "ready") {
      return "The review was stopped before the deck was finished.";
    }
    return null;
  }

  // A review run ends when its thread goes idle or fails — including when you
  // stop it yourself.
  bb.events.on("thread.idle", ({ thread }) => {
    const threadRun = threadRunForRunner(thread.id);
    if (threadRun !== null) {
      void finishThreadRun(threadRun);
      return;
    }
    const row = watchForThread(thread.id);
    if (row === null) return;
    void finishRun(row, runOutcome(row));
  });
  bb.events.on("thread.failed", ({ thread, error }) => {
    const threadRun = threadRunForRunner(thread.id);
    if (threadRun !== null) {
      void finishThreadRun(threadRun);
      return;
    }
    const row = watchForThread(thread.id);
    if (row === null) return;
    void finishRun(row, error ?? "The review thread failed.");
  });

  // -------------------------------------------------------------------------
  // Reviewing a thread's own changes
  // -------------------------------------------------------------------------

  interface ThreadRunRow {
    run_thread_id: string;
    source_thread_id: string;
    started_at: string;
  }

  function threadRunForRunner(runThreadId: string): ThreadRunRow | null {
    return (
      (db
        .prepare(`SELECT * FROM thread_runs WHERE run_thread_id = ?`)
        .get(runThreadId) as ThreadRunRow | undefined) ?? null
    );
  }

  function threadRunForSource(sourceThreadId: string): ThreadRunRow | null {
    const row = db
      .prepare(
        `SELECT * FROM thread_runs WHERE source_thread_id = ? ORDER BY started_at DESC LIMIT 1`,
      )
      .get(sourceThreadId) as ThreadRunRow | undefined;
    if (row === undefined) return null;
    const started = Date.parse(row.started_at);
    if (Number.isFinite(started) && Date.now() - started > RUN_TIMEOUT_MS) {
      db.prepare(`DELETE FROM thread_runs WHERE run_thread_id = ?`).run(
        row.run_thread_id,
      );
      return null;
    }
    return row;
  }

  function deckForSourceThread(sourceThreadId: string): string | null {
    const row = db
      .prepare(
        `SELECT id FROM decks WHERE source_thread_id = ? ORDER BY created_at DESC LIMIT 1`,
      )
      .get(sourceThreadId) as { id: string } | undefined;
    return row?.id ?? null;
  }

  /**
   * Reviews what a thread has changed, with a second agent in the same
   * workspace. A separate reviewer keeps the review honest — an agent asked to
   * find fault with its own work tends to agree with itself — and it sees
   * uncommitted edits, which a merge request would not.
   */
  async function startThreadReview(
    sourceThreadId: string,
    prompt?: string,
  ): Promise<{ started: boolean; message: string }> {
    const existing = threadRunForSource(sourceThreadId);
    if (existing !== null) {
      return { started: false, message: "A review of this thread is already running." };
    }

    let thread;
    try {
      thread = await bb.sdk.threads.get({ threadId: sourceThreadId });
    } catch (cause) {
      return {
        started: false,
        message: cause instanceof Error ? cause.message : String(cause),
      };
    }
    if (thread.environmentId === null) {
      return {
        started: false,
        message: "This thread has no workspace, so there is nothing to review.",
      };
    }

    const { defaultPrompt, hideReviewThreads } = await settings.get();
    const body = (prompt ?? "").trim() === "" ? defaultPrompt : (prompt as string);
    const title = thread.title ?? thread.titleFallback ?? "this thread";

    let runner;
    try {
      runner = await bb.sdk.threads.spawn({
        projectId: thread.projectId,
        // The same worktree, so the review covers uncommitted work too.
        environment: { type: "reuse", environmentId: thread.environmentId },
        title: `Review — ${title}`.slice(0, 120),
        visibility: hideReviewThreads ? "hidden" : "visible",
        prompt: [
          `Review the changes in this workspace. They were made by another agent working on: ${title}`,
          "",
          "Follow the review-deck skill and publish a review deck. Start with",
          "review_deck_changed_files to see what changed, and finish by calling",
          "review_deck_finish.",
          "",
          "Read the code before you judge it. Do not change any files — you are",
          "reviewing, not fixing.",
          "",
          "---",
          "",
          body,
        ].join("\n"),
      });
    } catch (cause) {
      return {
        started: false,
        message: cause instanceof Error ? cause.message : String(cause),
      };
    }

    db.prepare(
      `INSERT INTO thread_runs (run_thread_id, source_thread_id, started_at)
       VALUES (?, ?, ?)`,
    ).run(runner.id, sourceThreadId, now());
    changed();
    bb.log.info(`thread review started for ${sourceThreadId} in ${runner.id}`);
    return { started: true, message: "Reviewing this thread's changes…" };
  }

  /**
   * Ends a thread review. Unlike a merge-request run this only stops the
   * runner: the workspace belongs to the thread being reviewed, and archiving
   * the last thread of a managed worktree destroys it.
   */
  async function finishThreadRun(row: ThreadRunRow): Promise<void> {
    const deckId = deckForSourceThread(row.source_thread_id);
    if (deckId !== null) {
      restoreBackup(deckId);
      await snapshotPatches(deckId);
    }
    db.prepare(`DELETE FROM thread_runs WHERE run_thread_id = ?`).run(
      row.run_thread_id,
    );
    try {
      await bb.sdk.threads.stop({ threadId: row.run_thread_id });
    } catch {
      /* an idle runtime is already released */
    }
    changed();
  }

  /** A run is over once its thread is no longer working. */
  const RUNNING_STATUSES = new Set(["active", "starting", "stopping"]);

  /** Grace period so a thread that has not started yet is left alone. */
  const RUN_SETTLE_MS = 2 * 60 * 1000;

  async function threadStillWorking(threadId: string): Promise<boolean> {
    try {
      const thread = await bb.sdk.threads.get({ threadId });
      return RUNNING_STATUSES.has(thread.status);
    } catch {
      // The thread is gone; treat the run as over rather than stuck.
      return false;
    }
  }

  /**
   * Closes out runs whose finishing event never arrived — a plugin reload
   * during a review drops it, and the watch would otherwise sit on
   * "Reviewing…" until the timeout. Cheap to re-check, so the sweep does it
   * every time rather than trusting one ephemeral event.
   */
  async function reconcileRuns(): Promise<void> {
    for (const row of readWatchRows()) {
      if (row.run_thread_id === null || row.run_started_at === null) continue;
      const started = Date.parse(row.run_started_at);
      if (Number.isFinite(started) && Date.now() - started < RUN_SETTLE_MS) {
        continue;
      }
      if (await threadStillWorking(row.run_thread_id)) continue;
      bb.log.info(`reconciling finished review for ${row.url}`);
      const current = readWatchRow(row.id) ?? row;
      await finishRun(current, runOutcome(current));
    }
    for (const run of db
      .prepare(`SELECT * FROM thread_runs`)
      .all() as ThreadRunRow[]) {
      const started = Date.parse(run.started_at);
      if (Number.isFinite(started) && Date.now() - started < RUN_SETTLE_MS) {
        continue;
      }
      if (await threadStillWorking(run.run_thread_id)) continue;
      await finishThreadRun(run);
    }
  }

  /** One sweep: check every enabled watch and review the ones that moved. */
  async function pollWatches(): Promise<void> {
    await reconcileRuns();
    const { autoReview, reviewDraftMrs } = await settings.get();
    if (!autoReview) return;
    for (const row of readWatchRows()) {
      if (row.enabled !== 1) continue;
      if (runInFlight(row)) continue;
      const ref: MergeRequestRef = {
        hostname: row.hostname,
        projectPath: row.project_path,
        iid: row.iid,
      };
      let mr: MergeRequest;
      try {
        mr = await readMergeRequest(ref);
      } catch (cause) {
        setWatch(row.id, {
          state: "error",
          last_error: cause instanceof Error ? cause.message : String(cause),
          last_checked_at: now(),
        });
        continue;
      }
      setWatch(row.id, {
        title: mr.title,
        target_branch: mr.targetBranch,
        mr_state: mr.state,
        draft: mr.draft ? 1 : 0,
        head_sha: mr.sha,
        last_checked_at: now(),
      });
      if (mr.state !== "opened") continue;
      if (mr.draft && !reviewDraftMrs) continue;
      if (mr.sha === "" || mr.sha === row.last_sha) continue;
      // One automatic attempt per commit. A review that was stopped or that
      // failed must not be retried every sweep — that is an agent run every
      // few minutes for as long as the commit stays unreviewed. Press
      // "Review now" to try the same commit again.
      if (mr.sha === row.failed_sha) continue;
      await startReview(row.id);
    }
  }

  // -------------------------------------------------------------------------
  // Acting on a finished review
  // -------------------------------------------------------------------------

  /** The findings the reviewer agreed with, in deck order. */
  function agreedFindings(
    deck: Deck,
  ): { annotation: Annotation; note: string }[] {
    const out: { annotation: Annotation; note: string }[] = [];
    for (const slide of deck.slides) {
      for (const annotation of slide.annotations) {
        const reply = deck.verdicts[annotation.id];
        if (reply?.verdict !== "accepted") continue;
        out.push({ annotation, note: reply.note });
      }
    }
    return out;
  }

  function watchForDeck(deckId: string): WatchRow | null {
    return (
      (db.prepare(`SELECT * FROM watches WHERE deck_id = ?`).get(deckId) as
        | WatchRow
        | undefined) ?? null
    );
  }

  /**
   * The thread that should receive the reviewer's notes, or null.
   *
   * For a merge-request deck this is nobody: its `thread_id` is the reviewer,
   * which is archived with its worktree once the run ends. For a thread review
   * it is the thread whose work was reviewed. For a deck an agent wrote in an
   * ordinary conversation it is that conversation.
   */
  async function replyTargetForDeck(deckId: string): Promise<string | null> {
    const row = db
      .prepare(
        `SELECT thread_id, source_thread_id, watch_id FROM decks WHERE id = ?`,
      )
      .get(deckId) as
      | {
          thread_id: string | null;
          source_thread_id: string | null;
          watch_id: string | null;
        }
      | undefined;
    if (row === undefined) return null;
    const candidate =
      row.source_thread_id ?? (row.watch_id === null ? row.thread_id : null);
    if (candidate === null) return null;
    try {
      const thread = await bb.sdk.threads.get({ threadId: candidate });
      if (thread.archivedAt !== null && thread.archivedAt !== undefined) {
        return null;
      }
      return candidate;
    } catch {
      return null;
    }
  }

  function sourceThreadForDeck(deckId: string): string | null {
    const row = db
      .prepare(`SELECT source_thread_id FROM decks WHERE id = ?`)
      .get(deckId) as { source_thread_id: string | null } | undefined;
    return row?.source_thread_id ?? null;
  }

  /**
   * Where a follow-up agent should work.
   *
   * Never the deck's own `thread_id`: for a merge-request deck that is the
   * reviewer, which is archived and whose worktree is retired the moment the
   * review ends. Sending work there resumes a dead agent in a dead directory.
   */
  async function followUpEnvironment(
    deck: Deck,
    watch: WatchRow | null,
  ): Promise<
    | { ok: true; projectId: string; environment: Record<string, unknown>; setup: string[] }
    | { ok: false; message: string }
  > {
    const sourceThreadId = sourceThreadForDeck(deck.id);
    if (sourceThreadId !== null) {
      try {
        const thread = await bb.sdk.threads.get({ threadId: sourceThreadId });
        if (thread.environmentId !== null) {
          return {
            ok: true,
            projectId: thread.projectId,
            environment: { type: "reuse", environmentId: thread.environmentId },
            setup: [],
          };
        }
      } catch {
        /* fall through */
      }
    }

    if (watch !== null) {
      const ref: MergeRequestRef = {
        hostname: watch.hostname,
        projectPath: watch.project_path,
        iid: watch.iid,
      };
      const { reviewProject } = await settings.get();
      const project = await findProject(ref, reviewProject);
      if (project === null || project.hostId === null) {
        return {
          ok: false,
          message: `No BB project has ${remoteKey(ref)} as its git remote.`,
        };
      }
      return {
        ok: true,
        projectId: project.id,
        environment: {
          type: "host",
          hostId: project.hostId,
          workspace: { type: "managed-worktree", baseBranch: { kind: "default" } },
        },
        // A fresh worktree, so the branch has to be fetched before any change.
        setup: [
          "This is a fresh worktree. Put the merge request in it first:",
          "",
          "```sh",
          `git fetch origin "merge-requests/${watch.iid}/head:mr-${watch.iid}"`,
          `git switch mr-${watch.iid}`,
          "```",
          "",
        ],
      };
    }

    if (deck.projectId !== null) {
      return {
        ok: true,
        projectId: deck.projectId,
        environment: { type: "project-default" },
        setup: [],
      };
    }
    return { ok: false, message: "This deck is not linked to a project." };
  }

  /**
   * POSTs JSON to the GitLab API through glab.
   *
   * The body goes in on stdin as real JSON. Passing `position[...]` as form
   * fields silently drops the position and the comment lands unanchored at the
   * bottom of the merge request instead of on the line it is about.
   */
  function glabPostJson(
    hostname: string,
    path: string,
    body: unknown,
  ): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const child = spawn(
        GLAB,
        [
          "api",
          "--hostname",
          hostname,
          path,
          "-X",
          "POST",
          "-H",
          "Content-Type: application/json",
          "--input",
          "-",
        ],
        { stdio: ["pipe", "pipe", "pipe"] },
      );
      let out = "";
      let err = "";
      child.stdout.on("data", (chunk) => (out += String(chunk)));
      child.stderr.on("data", (chunk) => (err += String(chunk)));
      child.on("error", (cause) =>
        reject(
          new Error(
            (cause as { code?: string }).code === "ENOENT"
              ? `${GLAB} is not installed on the BB server.`
              : String(cause),
          ),
        ),
      );
      child.on("close", (code) => {
        if (code !== 0) {
          reject(new Error(err.trim().split("\n")[0] ?? `glab exited ${code}`));
          return;
        }
        try {
          resolve(JSON.parse(out));
        } catch {
          reject(new Error("GitLab returned something that is not JSON."));
        }
      });
      child.stdin.end(JSON.stringify(body));
    });
  }

  /** One finding, written the way it should read on the merge request. */
  function findingComment(annotation: Annotation, reviewerNote: string): string {
    const lines = [`**${annotation.severity.toUpperCase()} — ${annotation.title}**`];
    if (annotation.body.trim() !== "") {
      lines.push("", annotation.body.trim());
    }
    if (annotation.suggestion !== undefined && annotation.suggestion.trim() !== "") {
      lines.push("", "```suggestion", annotation.suggestion.trim(), "```");
    }
    if (reviewerNote.trim() !== "") {
      lines.push("", `_Reviewer: ${reviewerNote.trim()}_`);
    }
    return lines.join("\n");
  }

  /**
   * Posts the findings the reviewer agreed with onto the merge request, each
   * anchored to its own line. Only agreed findings go out: the reviewer has
   * endorsed those, and nothing should reach a shared merge request that they
   * did not choose to send.
   */
  async function postDeckToMr(deckId: string): Promise<{
    posted: number;
    failed: { title: string; reason: string }[];
    message: string;
  }> {
    const deck = readDeck(deckId);
    if (deck === null) {
      return { posted: 0, failed: [], message: `No deck with id ${deckId}.` };
    }
    const watch = watchForDeck(deckId);
    if (watch === null) {
      return {
        posted: 0,
        failed: [],
        message: "This deck is not linked to a merge request.",
      };
    }
    const agreed = agreedFindings(deck);
    if (agreed.length === 0) {
      return {
        posted: 0,
        failed: [],
        message:
          "Nothing to post. Mark the findings you agree with first — only those are sent.",
      };
    }

    const encoded = encodeURIComponent(watch.project_path);
    let refs: { base_sha: string; start_sha: string; head_sha: string };
    try {
      const mr = await glabApi<{ diff_refs?: typeof refs }>(
        watch.hostname,
        `projects/${encoded}/merge_requests/${watch.iid}`,
      );
      if (mr.diff_refs === undefined) {
        return {
          posted: 0,
          failed: [],
          message: "GitLab did not return diff refs for this merge request.",
        };
      }
      refs = mr.diff_refs;
    } catch (cause) {
      return {
        posted: 0,
        failed: [],
        message: cause instanceof Error ? cause.message : String(cause),
      };
    }

    let posted = 0;
    const failed: { title: string; reason: string }[] = [];
    for (const { annotation, note } of agreed) {
      const position = diffNotePosition(annotation, refs);
      try {
        const created = (await glabPostJson(
          watch.hostname,
          `projects/${encoded}/merge_requests/${watch.iid}/discussions`,
          { body: findingComment(annotation, note), position },
        )) as { notes?: { type?: string }[] };
        // An unanchored reply comes back as DiscussionNote; a real inline
        // comment is a DiffNote. Report the difference rather than hide it.
        if (created.notes?.[0]?.type !== "DiffNote") {
          failed.push({
            title: annotation.title,
            reason: "posted, but GitLab did not anchor it to the line",
          });
          continue;
        }
        posted += 1;
      } catch (cause) {
        failed.push({
          title: annotation.title,
          reason: cause instanceof Error ? cause.message : String(cause),
        });
      }
    }

    return {
      posted,
      failed,
      message:
        failed.length === 0
          ? `Posted ${posted} comment${posted === 1 ? "" : "s"} to !${watch.iid}.`
          : `Posted ${posted}; ${failed.length} did not go through.`,
    };
  }

  /** The conversation attached to this deck, if it still exists. */
  async function discussionThreadForDeck(deckId: string): Promise<string | null> {
    const row = db
      .prepare(`SELECT discussion_thread_id FROM decks WHERE id = ?`)
      .get(deckId) as { discussion_thread_id: string | null } | undefined;
    const threadId = row?.discussion_thread_id ?? null;
    if (threadId === null) return null;
    try {
      await bb.sdk.threads.get({ threadId });
      return threadId;
    } catch {
      // Deleted since. Forget it so the next Discuss starts a fresh one.
      db.prepare(
        `UPDATE decks SET discussion_thread_id = NULL WHERE id = ?`,
      ).run(deckId);
      return null;
    }
  }

  /** Opens a thread that can actually act on the review. */
  async function actOnDeck(
    deckId: string,
    intent: "ask" | "discuss" | "fix",
  ): Promise<{ ok: boolean; threadId: string | null; message: string }> {
    const deck = readDeck(deckId);
    if (deck === null) {
      return { ok: false, threadId: null, message: `No deck with id ${deckId}.` };
    }

    // "ask" and "discuss" share one conversation per deck. Opening the chat
    // while still reading must not be treated as finishing: only "discuss"
    // hands over the notes, and only when you press it.
    if (intent !== "fix") {
      const existing = await discussionThreadForDeck(deckId);
      if (existing !== null) {
        if (intent === "discuss") {
          try {
            await bb.sdk.threads.send({
              threadId: existing,
              mode: "auto",
              input: [
                {
                  type: "text",
                  text: [
                    "I have been through the whole deck. Here is what I decided:",
                    "",
                    notesMarkdown(deck),
                    "",
                    "Tell me what you think the real work is, then offer next steps and wait.",
                  ].join("\n"),
                  mentions: [],
                },
              ],
            });
          } catch (cause) {
            return {
              ok: false,
              threadId: existing,
              message: cause instanceof Error ? cause.message : String(cause),
            };
          }
          return { ok: true, threadId: existing, message: "Sent your notes." };
        }
        return { ok: true, threadId: existing, message: "Reopened the chat." };
      }
    }
    const watch = watchForDeck(deckId);
    const where = await followUpEnvironment(deck, watch);
    if (!where.ok) return { ok: false, threadId: null, message: where.message };

    const agreed = agreedFindings(deck);
    const heading =
      watch === null
        ? `the review of ${deck.title}`
        : `the review of !${watch.iid} — ${watch.title}`;

    const shared = [
      ...where.setup,
      "Here is what the reviewer decided:",
      "",
      notesMarkdown(deck),
      "",
      "---",
      "",
    ];

    // Opening the chat mid-review. The agent is a reference, not a wrap-up: no
    // summary nobody asked for, no next steps, no edits.
    const askPrompt = [
      ...where.setup,
      `I am reading a review deck and may have questions about it: ${heading}.`,
      "",
      `The deck has ${deck.slides.length} slide${deck.slides.length === 1 ? "" : "s"}:`,
      "",
      ...deck.slides.map(
        (slide) =>
          `${slide.position}. ${slide.title}` +
          (slide.annotations.length === 0
            ? ""
            : ` — ${slide.annotations.length} finding${slide.annotations.length === 1 ? "" : "s"}`),
      ),
      deck.summary.trim() === "" ? "" : `\nWhat the change does: ${deck.summary.trim()}`,
      "",
      "You are here to answer my questions while I read. Read the code when you",
      "need to before answering.",
      "",
      "If I ask you to change the deck — drop a finding, reword a slide, fix a",
      "severity or a line number — use review_deck_read then review_deck_edit.",
      "That edits the deck I am looking at, so I see it immediately. Never",
      "build a new deck for a change I asked for.",
      "",
      "Do not summarise the deck, do not tell me what to do next, and do not",
      "change any code files or post anything — I have not finished reviewing.",
      "Reply with one short line to say you have the deck, then wait for me.",
    ].join("\n");

    const prompt =
      intent === "ask"
        ? askPrompt
        : intent === "fix"
        ? [
            `Apply the findings the reviewer agreed with, from ${heading}.`,
            "",
            ...shared,
            agreed.length === 0
              ? "The reviewer has not agreed to any finding yet. Ask which ones they want before changing anything."
              : `Work through the ${agreed.length} agreed finding${agreed.length === 1 ? "" : "s"} above, in order. Read the code around each one before you change it — a finding can be wrong.`,
            "",
            "Where you disagree with a finding, say so and leave the code alone rather than making a change you do not believe in.",
            "Do not push or post anything without being asked.",
            "When you are done, list what you changed and what you skipped.",
          ].join("\n")
        : [
            `The reviewer has finished ${heading} and wants to talk about it.`,
            "",
            ...shared,
            "Start by telling them, in a few lines, what the review concluded and what you think the real work is.",
            "",
            "Then offer them concrete next steps and wait for an answer. Depending on the deck these are usually:",
            "",
            `- fix the ${agreed.length} agreed finding${agreed.length === 1 ? "" : "s"} here`,
            watch === null
              ? "- explain any finding in more depth"
              : `- post the agreed findings to !${watch.iid} as inline comments (\`bb review-deck post ${deckId}\` does this properly, anchored to each line)`,
            "- explain any finding in more depth, or argue back if you think one is wrong",
            "",
            "Do not start changing code, and do not post anything, until they pick.",
          ].join("\n");

    try {
      const thread = await bb.sdk.threads.spawn({
        projectId: where.projectId,
        environment: where.environment as never,
        title:
          intent === "fix"
            ? `Fix — ${deck.title}`.slice(0, 120)
            : `Deck chat — ${deck.title}`.slice(0, 120),
        prompt,
      });
      // Both chat intents share the deck's one conversation.
      if (intent === "fix") {
        // So the deck is right there while the findings are being fixed.
        attachDeckToThread(deckId, thread.id, "fix");
      } else {
        db.prepare(
          `UPDATE decks SET discussion_thread_id = ?, updated_at = ? WHERE id = ?`,
        ).run(thread.id, now(), deckId);
        changed();
      }
      return {
        ok: true,
        threadId: thread.id,
        message:
          intent === "fix" ? "Opened a thread to fix these." : "Opened a chat.",

      };
    } catch (cause) {
      return {
        ok: false,
        threadId: null,
        message: cause instanceof Error ? cause.message : String(cause),
      };
    }
  }

  // -------------------------------------------------------------------------
  // RPC
  // -------------------------------------------------------------------------

  bb.rpc.register(rpcContract, {
    decks_list: ({ projectId }) => ({ decks: listDecks(projectId) }),
    deck_get: ({ deckId }) => {
      const deck = readDeck(deckId);
      if (deck === null) throw new Error(`No deck with id ${deckId}`);
      return { deck };
    },
    deck_for_thread: ({ threadId }) => {
      const row = db
        .prepare(
          `SELECT id FROM decks
           WHERE source_thread_id = ? OR thread_id = ?
           ORDER BY created_at DESC LIMIT 1`,
        )
        .get(threadId, threadId) as { id: string } | undefined;
      return { deckId: row?.id ?? null };
    },
    deck_delete: ({ deckId }) => ({ removed: deleteDeck(deckId) }),
    slide_patches: async ({ deckId, slideId }) => {
      const deck = readDeck(deckId);
      if (deck === null) throw new Error(`No deck with id ${deckId}`);
      const slide = deck.slides.find((entry) => entry.id === slideId);
      if (slide === undefined) throw new Error(`No slide with id ${slideId}`);
      return { patches: await resolvePatches(deck, slide) };
    },
    slide_set_state: ({ deckId, slideId, state, note }) => {
      const slide = readDeck(deckId)?.slides.find((item) => item.id === slideId);
      db.prepare(
        `INSERT INTO slide_state (slide_id, deck_id, state, note, updated_at, content_key)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(slide_id) DO UPDATE SET state = excluded.state,
                                             note = excluded.note,
                                             updated_at = excluded.updated_at,
                                             content_key = excluded.content_key`,
      ).run(
        slideId,
        deckId,
        state,
        note ?? "",
        now(),
        slide === undefined ? null : slideKey(slide.title),
      );
      changed();
      return { ok: true as const };
    },
    annotation_set_verdict: ({ deckId, annotationId, verdict, note }) => {
      const found = readDeck(deckId)
        ?.slides.flatMap((slide) => slide.annotations)
        .find((annotation) => annotation.id === annotationId);
      db.prepare(
        `INSERT INTO annotation_verdict (annotation_id, deck_id, verdict, note, updated_at, content_key)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(annotation_id) DO UPDATE SET verdict = excluded.verdict,
                                                  note = excluded.note,
                                                  updated_at = excluded.updated_at,
                                                  content_key = excluded.content_key`,
      ).run(
        annotationId,
        deckId,
        verdict,
        note ?? "",
        now(),
        found === undefined ? null : annotationKey(found.path, found.title),
      );
      changed();
      return { ok: true as const };
    },
    deck_notes: ({ deckId }) => {
      const deck = readDeck(deckId);
      if (deck === null) throw new Error(`No deck with id ${deckId}`);
      return { markdown: notesMarkdown(deck) };
    },
    deck_send_notes: async ({ deckId }) => {
      const deck = readDeck(deckId);
      if (deck === null) throw new Error(`No deck with id ${deckId}`);
      const target = await replyTargetForDeck(deckId);
      if (target === null) {
        return {
          sent: false,
          threadId: null,
          message:
            "There is no live thread to reply to. Use “Talk it through with an agent” instead.",
        };
      }
      await bb.sdk.threads.send({
        threadId: target,
        mode: "auto",
        input: [{ type: "text", text: notesMarkdown(deck), mentions: [] }],
      });
      return { sent: true, threadId: target, message: "Notes sent to the thread." };
    },

    watches_list: async () => {
      const rows = readWatchRows();
      await loadProjectNames(rows);
      const { defaultPrompt, autoReview } = await settings.get();
      return { watches: rows.map(toWatch), defaultPrompt, autoReview };
    },

    watch_add: (input) => addWatch(input),

    watch_update: ({ watchId, prompt, enabled }) => {
      const fields: Record<string, unknown> = {};
      if (prompt !== undefined) fields.prompt = prompt.trim();
      if (enabled !== undefined) fields.enabled = enabled ? 1 : 0;
      setWatch(watchId, fields);
      return { ok: true as const };
    },

    watch_remove: ({ watchId }) => {
      const result = db.prepare(`DELETE FROM watches WHERE id = ?`).run(watchId);
      if (result.changes > 0) watchChanged();
      return { removed: result.changes > 0 };
    },

    watch_run_now: ({ watchId }) => startReview(watchId, { force: true }),

    thread_review_start: ({ threadId, prompt }) =>
      startThreadReview(threadId, prompt),

    skills_list: async ({ projectId }) => {
      // Skills are listed per workspace. Any real project gives the same
      // user-level and builtin skills, so fall back to the first one rather
      // than making the caller find a project id it does not have.
      let target = projectId ?? null;
      if (target === null) {
        try {
          const projects = await bb.sdk.projects.list({ includePersonal: true });
          target = projects[0]?.id ?? null;
        } catch {
          target = null;
        }
      }
      if (target === null) return { skills: [] };
      try {
        const { skills } = await bb.sdk.skills.list({
          projectId: target,
          environmentId: null,
        });
        // Yours first, then shared, then everything BB and plugins provide.
        const rank = (scope: string) =>
          scope.endsWith("-user") ? 0 : scope.endsWith("-project") ? 1 : 2;
        return {
          skills: skills
            .map((skill) => ({
              name: skill.name,
              description: skill.description ?? "",
              scope: skill.scope,
            }))
            .sort(
              (a, b) =>
                rank(a.scope) - rank(b.scope) || a.name.localeCompare(b.name),
            ),
        };
      } catch {
        return { skills: [] };
      }
    },

    deck_next_actions: async ({ deckId }) => {
      const deck = readDeck(deckId);
      if (deck === null) throw new Error(`No deck with id ${deckId}`);
      const watch = watchForDeck(deckId);
      const all = deck.slides.flatMap((slide) => slide.annotations);
      return {
        replyThreadId: await replyTargetForDeck(deckId),
        discussionThreadId: await discussionThreadForDeck(deckId),
        agreedCount: agreedFindings(deck).length,
        openCount: all.filter(
          (item) => (deck.verdicts[item.id]?.verdict ?? "open") === "open",
        ).length,
        canPostToMr: watch !== null,
        mrUrl: watch?.url ?? null,
        mrLabel: watch === null ? null : `!${watch.iid}`,
      };
    },
    deck_act: ({ deckId, intent }) => actOnDeck(deckId, intent),

    deck_discuss_slide: async ({ deckId, slideId }) => {
      const deck = readDeck(deckId);
      if (deck === null) {
        return { ok: false, threadId: null, message: `No deck with id ${deckId}.` };
      }
      const slide = deck.slides.find((entry) => entry.id === slideId);
      if (slide === undefined) {
        return { ok: false, threadId: null, message: "No such slide." };
      }
      const chat = await actOnDeck(deckId, "ask");
      if (!chat.ok || chat.threadId === null) return chat;

      // Give the agent the slide, so the question does not start from nothing.
      const lines = [
        `Let's talk about slide ${slide.position} — **${slide.title}**.`,
        "",
        slide.summary.trim() === "" ? null : slide.summary.trim(),
        slide.files.length === 0
          ? null
          : `\nFiles: ${slide.files.map((file) => `\`${file.path}\``).join(", ")}`,
        slide.annotations.length === 0
          ? null
          : "\nFindings on this slide:\n" +
            slide.annotations
              .map((item) => {
                const verdict = deck.verdicts[item.id]?.verdict ?? "open";
                const mark =
                  verdict === "accepted"
                    ? "I agreed"
                    : verdict === "rejected"
                      ? "I disagreed"
                      : "not answered";
                return `- ${item.severity.toUpperCase()} \`${item.path}:${item.line}\` — ${item.title} (${mark})`;
              })
              .join("\n"),
        "",
        "Wait for my question before doing anything.",
      ].filter((line) => line !== null);

      try {
        await bb.sdk.threads.send({
          threadId: chat.threadId,
          mode: "auto",
          input: [{ type: "text", text: lines.join("\n"), mentions: [] }],
        });
      } catch (cause) {
        return {
          ok: false,
          threadId: chat.threadId,
          message: cause instanceof Error ? cause.message : String(cause),
        };
      }
      return {
        ok: true,
        threadId: chat.threadId,
        message: `Asked about slide ${slide.position}.`,
      };
    },
    deck_post_to_mr: ({ deckId }) => postDeckToMr(deckId),
    /**
     * Asks the thread that already did a review to publish it as a deck.
     *
     * No second agent and no re-reading: this agent has the review in its
     * context, so it only needs to call the tools. Spawning a reviewer here
     * would redo minutes of work for an answer that already exists.
     */
    thread_publish_review: async ({ threadId, note }) => {
      const existing = deckForContext(threadId);
      if (existing !== null) {
        return {
          ok: false,
          message: "This thread already has a deck. Detach it first if you want another.",
        };
      }
      const lines = [
        "Publish the review you have already done in this thread as a review deck.",
        "",
        "Use what you already found. Do not review anything again and do not",
        "re-read the whole diff — you have the findings, this is only about",
        "putting them into slides.",
        "",
        "Follow the review-deck skill: review_deck_create, then",
        "review_deck_add_slide once per group of related changes, then",
        "review_deck_finish. Pin each finding to the file and line you already",
        "identified. If you are unsure of a line number, check that one file",
        "rather than starting over.",
        "",
        "If you have not actually reviewed anything in this thread yet, say so",
        "instead of inventing a deck.",
      ];
      if ((note ?? "").trim() !== "") {
        lines.push("", "---", "", (note as string).trim());
      }
      try {
        await bb.sdk.threads.send({
          threadId,
          mode: "auto",
          input: [{ type: "text", text: lines.join("\n"), mentions: [] }],
        });
      } catch (cause) {
        return {
          ok: false,
          message: cause instanceof Error ? cause.message : String(cause),
        };
      }
      return { ok: true, message: "Asked this thread to publish its review." };
    },

    deck_attach: ({ deckId, threadId }) => {
      if (readDeckRow(deckId) === null) {
        throw new Error(`No deck with id ${deckId}`);
      }
      attachDeckToThread(deckId, threadId, "attached");
      return { ok: true as const };
    },
    deck_detach: ({ threadId }) => {
      const result = db
        .prepare(`DELETE FROM deck_threads WHERE thread_id = ?`)
        .run(threadId);
      if (result.changes > 0) changed();
      return { detached: result.changes > 0 };
    },
    thread_review_status: ({ threadId }) => {
      const countSlides = (deckId: string | null) =>
        deckId === null
          ? 0
          : (db
              .prepare(`SELECT COUNT(*) AS n FROM slides WHERE deck_id = ?`)
              .get(deckId) as { n: number }).n;

      // Is this thread the reviewer? Then the panel beside it should show the
      // deck it is writing, not offer to start another review.
      // Is this thread doing a review right now? Ask the run, not the deck: a
      // reviewer spends its first minutes reading code and has no deck yet,
      // and until it does the panel used to offer to start another review.
      const liveWatch = db
        .prepare(
          `SELECT iid, title, deck_id FROM watches WHERE run_thread_id = ?`,
        )
        .get(threadId) as
        | { iid: number; title: string; deck_id: string | null }
        | undefined;
      if (liveWatch !== undefined) {
        return {
          running: true,
          runThreadId: threadId,
          deckId: liveWatch.deck_id,
          slideCount: countSlides(liveWatch.deck_id),
          isRunner: true,
          reviewing: `!${liveWatch.iid} — ${liveWatch.title}`,
          canStartReview: false,
          attachedAs: null,
          attachedDeckTitle: null,
        };
      }
      const liveRun = threadRunForRunner(threadId);
      if (liveRun !== null) {
        const deckId = deckForSourceThread(liveRun.source_thread_id);
        return {
          running: true,
          runThreadId: threadId,
          deckId,
          slideCount: countSlides(deckId),
          isRunner: true,
          reviewing: "this thread's changes",
          canStartReview: false,
          attachedAs: null,
          attachedDeckTitle: null,
        };
      }

      // The run is over. A review run's deck carries a watch or a reviewed
      // thread; a deck an agent wrote in an ordinary conversation carries
      // neither, and that conversation is still one you can ask to review.
      const written = db
        .prepare(
          `SELECT id, title FROM decks
           WHERE thread_id = ? AND (watch_id IS NOT NULL OR source_thread_id IS NOT NULL)
           ORDER BY created_at DESC LIMIT 1`,
        )
        .get(threadId) as { id: string; title: string } | undefined;
      if (written !== undefined) {
        return {
          running: false,
          runThreadId: threadId,
          deckId: written.id,
          slideCount: countSlides(written.id),
          isRunner: true,
          reviewing: written.title,
          canStartReview: false,
          attachedAs: null,
          attachedDeckTitle: null,
        };
      }

      const run = threadRunForSource(threadId);
      // Either a review of this thread, or a deck an agent wrote here itself.
      const own = db
        .prepare(
          `SELECT id FROM decks
           WHERE source_thread_id = ? OR thread_id = ?
           ORDER BY created_at DESC LIMIT 1`,
        )
        .get(threadId, threadId) as { id: string } | undefined;

      // Nothing of its own: a deck may still be linked here, by a fix run or
      // because you attached one.
      if (own === undefined) {
        const link = db
          .prepare(
            `SELECT t.deck_id, t.role, d.title FROM deck_threads t
             JOIN decks d ON d.id = t.deck_id
             WHERE t.thread_id = ? ORDER BY t.created_at DESC LIMIT 1`,
          )
          .get(threadId) as
          | { deck_id: string; role: string; title: string }
          | undefined;
        if (link !== undefined) {
          return {
            running: false,
            runThreadId: null,
            deckId: link.deck_id,
            slideCount: countSlides(link.deck_id),
            isRunner: false,
            reviewing: null,
            canStartReview: true,
            attachedAs: link.role,
            attachedDeckTitle: link.title,
          };
        }
      }

      const deckId = own?.id ?? null;
      return {
        running: run !== null,
        runThreadId: run?.run_thread_id ?? null,
        deckId,
        slideCount: countSlides(deckId),
        isRunner: false,
        reviewing: null,
        canStartReview: true,
        attachedAs: null,
        attachedDeckTitle: null,
      };
    },
  });

  // -------------------------------------------------------------------------
  // Editing a deck that already exists
  // -------------------------------------------------------------------------

  /**
   * The deck a thread is about, so an agent can be asked to change "this deck"
   * without being told an id. A deck's chat comes first, then the reviewer
   * that wrote it, then the thread whose work was reviewed.
   */
  function deckForContext(threadId: string | undefined): string | null {
    if (threadId === undefined) return null;
    for (const column of [
      "discussion_thread_id",
      "thread_id",
      "source_thread_id",
    ]) {
      const row = db
        .prepare(
          `SELECT id FROM decks WHERE ${column} = ? ORDER BY created_at DESC LIMIT 1`,
        )
        .get(threadId) as { id: string } | undefined;
      if (row !== undefined) return row.id;
    }
    return attachedDeckForThread(threadId);
  }

  /** A deck linked to this thread by a fix run or by hand. */
  function attachedDeckForThread(threadId: string): string | null {
    const row = db
      .prepare(
        `SELECT d.id FROM deck_threads t
         JOIN decks d ON d.id = t.deck_id
         WHERE t.thread_id = ?
         ORDER BY t.created_at DESC LIMIT 1`,
      )
      .get(threadId) as { id: string } | undefined;
    return row?.id ?? null;
  }

  function attachDeckToThread(
    deckId: string,
    threadId: string,
    role: string,
  ): void {
    db.prepare(
      `INSERT INTO deck_threads (deck_id, thread_id, role, created_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(deck_id, thread_id) DO UPDATE SET role = excluded.role`,
    ).run(deckId, threadId, role, now());
    changed();
  }

  function renumberSlides(deckId: string): void {
    const rows = db
      .prepare(`SELECT id FROM slides WHERE deck_id = ? ORDER BY position ASC`)
      .all(deckId) as { id: string }[];
    rows.forEach((row, index) => {
      db.prepare(`UPDATE slides SET position = ? WHERE id = ?`).run(
        index + 1,
        row.id,
      );
    });
  }

  function resolveSlide(deckId: string, ref: SlideRef): SlideRow | null {
    const row =
      typeof ref === "number"
        ? db
            .prepare(`SELECT * FROM slides WHERE deck_id = ? AND position = ?`)
            .get(deckId, ref)
        : db
            .prepare(`SELECT * FROM slides WHERE deck_id = ? AND id = ?`)
            .get(deckId, ref);
    return (row as SlideRow | undefined) ?? null;
  }

  function findAnnotation(
    deckId: string,
    annotationId: string,
  ): { slide: SlideRow; annotations: Annotation[]; index: number } | null {
    for (const slide of readSlideRows(deckId)) {
      const annotations = parseJson<Annotation[]>(slide.annotations, []);
      const index = annotations.findIndex((item) => item.id === annotationId);
      if (index >= 0) return { slide, annotations, index };
    }
    return null;
  }

  function writeAnnotations(slideId: string, annotations: Annotation[]): void {
    db.prepare(`UPDATE slides SET annotations = ? WHERE id = ?`).run(
      JSON.stringify(annotations),
      slideId,
    );
  }

  /**
   * Applies one batch of edits. Each operation reports what it did or why it
   * could not, so a wrong slide reference is visible rather than silent.
   */
  function applyDeckOperations(
    deckId: string,
    operations: DeckOperation[],
  ): string[] {
    const log: string[] = [];
    for (const operation of operations) {
      switch (operation.op) {
        case "set_deck": {
          const row = readDeckRow(deckId);
          if (row === null) break;
          db.prepare(
            `UPDATE decks SET title = ?, summary = ?, updated_at = ? WHERE id = ?`,
          ).run(
            operation.title ?? row.title,
            operation.summary ?? row.summary,
            now(),
            deckId,
          );
          log.push("updated the deck's title or summary");
          break;
        }
        case "add_slide": {
          const { op, after, ...rest } = operation;
          const slide = insertSlide(deckId, rest as SlideInput);
          if (after !== undefined) {
            const anchorSlide = resolveSlide(deckId, after);
            if (anchorSlide !== null) {
              db.prepare(`UPDATE slides SET position = ? WHERE id = ?`).run(
                anchorSlide.position + 0.5,
                slide.id,
              );
              renumberSlides(deckId);
            }
          }
          log.push(`added slide "${slide.title}"`);
          break;
        }
        case "edit_slide": {
          const slide = resolveSlide(deckId, operation.slide);
          if (slide === null) {
            log.push(`no slide ${String(operation.slide)}`);
            break;
          }
          db.prepare(
            `UPDATE slides SET title = ?, kind = ?, summary = ?, why = ?, files = ?, diagram = ?
             WHERE id = ?`,
          ).run(
            operation.title ?? slide.title,
            operation.kind ?? slide.kind,
            operation.summary ?? slide.summary,
            operation.why === undefined ? slide.why : (operation.why ?? null),
            operation.files === undefined
              ? slide.files
              : JSON.stringify(operation.files),
            operation.diagram === undefined
              ? slide.diagram
              : operation.diagram === null
                ? null
                : JSON.stringify(operation.diagram),
            slide.id,
          );
          // The reviewer's mark on this slide is keyed by its wording.
          if (operation.title !== undefined) {
            db.prepare(
              `UPDATE slide_state SET content_key = ? WHERE slide_id = ?`,
            ).run(slideKey(operation.title), slide.id);
          }
          log.push(`edited slide ${slide.position}`);
          break;
        }
        case "remove_slide": {
          const slide = resolveSlide(deckId, operation.slide);
          if (slide === null) {
            log.push(`no slide ${String(operation.slide)}`);
            break;
          }
          db.prepare(`DELETE FROM slides WHERE id = ?`).run(slide.id);
          db.prepare(`DELETE FROM slide_state WHERE slide_id = ?`).run(slide.id);
          renumberSlides(deckId);
          log.push(`removed slide "${slide.title}"`);
          break;
        }
        case "move_slide": {
          const slide = resolveSlide(deckId, operation.slide);
          if (slide === null) {
            log.push(`no slide ${String(operation.slide)}`);
            break;
          }
          db.prepare(`UPDATE slides SET position = ? WHERE id = ?`).run(
            operation.to - 0.5,
            slide.id,
          );
          renumberSlides(deckId);
          log.push(`moved "${slide.title}" to ${operation.to}`);
          break;
        }
        case "add_finding": {
          const { op, slide: ref, ...annotation } = operation;
          const slide = resolveSlide(deckId, ref);
          if (slide === null) {
            log.push(`no slide ${String(ref)}`);
            break;
          }
          const annotations = parseJson<Annotation[]>(slide.annotations, []);
          const id = `${slide.id}-a${randomUUID().slice(0, 6)}`;
          annotations.push({ ...annotation, id });
          writeAnnotations(slide.id, annotations);
          log.push(`added a ${annotation.severity} finding to slide ${slide.position}`);
          break;
        }
        case "edit_finding": {
          const found = findAnnotation(deckId, operation.finding);
          if (found === null) {
            log.push(`no finding ${operation.finding}`);
            break;
          }
          const current = found.annotations[found.index]!;
          const next: Annotation = {
            ...current,
            path: operation.path ?? current.path,
            line: operation.line ?? current.line,
            endLine:
              operation.endLine === undefined
                ? current.endLine
                : (operation.endLine ?? undefined),
            side: operation.side ?? current.side,
            severity: operation.severity ?? current.severity,
            title: operation.title ?? current.title,
            body: operation.body ?? current.body,
            suggestion:
              operation.suggestion === undefined
                ? current.suggestion
                : (operation.suggestion ?? undefined),
          };
          found.annotations[found.index] = next;
          writeAnnotations(found.slide.id, found.annotations);
          // Keep the reviewer's answer attached, and re-key it to the new
          // wording so a later re-review still matches it.
          db.prepare(
            `UPDATE annotation_verdict SET content_key = ? WHERE annotation_id = ?`,
          ).run(annotationKey(next.path, next.title), next.id);
          log.push(`edited finding "${next.title}"`);
          break;
        }
        case "remove_finding": {
          const found = findAnnotation(deckId, operation.finding);
          if (found === null) {
            log.push(`no finding ${operation.finding}`);
            break;
          }
          const [removed] = found.annotations.splice(found.index, 1);
          writeAnnotations(found.slide.id, found.annotations);
          db.prepare(`DELETE FROM annotation_verdict WHERE annotation_id = ?`).run(
            operation.finding,
          );
          log.push(`removed finding "${removed?.title ?? operation.finding}"`);
          break;
        }
      }
    }
    db.prepare(`UPDATE decks SET updated_at = ? WHERE id = ?`).run(now(), deckId);
    changed();
    return log;
  }

  // -------------------------------------------------------------------------
  // Agent tools — how an agent turns its review into a deck
  // -------------------------------------------------------------------------

  bb.agents.registerTool({
    name: "review_deck_changed_files",
    description:
      "List the files changed in the current workspace, with per-file added/removed line counts. Call this first when building a review deck so you know what to group into slides.",
    instructions:
      "Use review_deck_changed_files before review_deck_create so slides cover the real change set.",
    presentation: {
      label: {
        pending: "Listing changed files",
        completed: "Listed changed files",
      },
    },
    parameters: z
      .object({
        target: diffTargetSchema.nullish().describe(
          'Which diff to read. Omit to use the plugin default (branch + uncommitted). Examples: {"target":"uncommitted"} or {"target":"all","mergeBaseBranch":"main"}.',
        ),
      })
      .strict(),
    async execute({ target }, ctx) {
      const { environmentId } = await environmentForThread(ctx.threadId);
      if (environmentId === null) {
        return {
          content: [
            {
              type: "text",
              text: "This thread has no workspace, so there is no diff to read.",
            },
          ],
          isError: true,
        };
      }
      const resolved = target ?? (await defaultTarget(environmentId));
      const diff = await readChangedFiles(environmentId, resolved);
      if (!diff.ok) {
        return {
          content: [
            { type: "text", text: diff.message || "Could not read the diff." },
          ],
          isError: true,
        };
      }
      return JSON.stringify(
        {
          target: resolved,
          shortstat: diff.shortstat,
          files: diff.files,
        },
        null,
        2,
      );
    },
  });

  bb.agents.registerTool({
    name: "review_deck_create",
    description:
      "Start a review deck: a slide show that walks a human reviewer through one change. Returns a deckId to pass to review_deck_add_slide. Create the deck first, then add one slide per group of related changes, then call review_deck_finish.",
    instructions:
      "After reviewing code, publish the findings as a review deck with review_deck_create, review_deck_add_slide and review_deck_finish instead of writing a long chat message.",
    presentation: {
      label: { pending: "Creating review deck", completed: "Created review deck" },
    },
    parameters: z
      .object({
        title: z
          .string()
          .min(1)
          .max(160)
          .describe("Short name for the change, e.g. 'Retry failed payouts'."),
        summary: z
          .string()
          .max(4000)
          .default("")
          .describe(
            "Two to four sentences in plain language: what the change does and why. Markdown is allowed.",
          ),
        target: diffTargetSchema
          .nullish()
          .describe("Which diff this deck reviews. Omit for the default."),
      })
      .strict(),
    async execute({ title, summary, target }, ctx) {
      const { environmentId, projectId } = await environmentForThread(
        ctx.threadId,
      );
      const resolved =
        target ?? (await defaultTarget(environmentId ?? null));
      let shortstat = "";
      if (environmentId !== null) {
        const diff = await readChangedFiles(environmentId, resolved);
        shortstat = diff.shortstat;
      }
      const timestamp = now();

      // When this thread is a watched merge request's review run, the deck it
      // already has is rewritten in place. The link the reviewer bookmarked
      // keeps working and their marks are carried onto the new findings.
      const watch = watchForThread(ctx.threadId);
      const threadRun = threadRunForRunner(ctx.threadId);

      // A thread review keeps one deck per reviewed thread, rewritten in place
      // just like a watched merge request, so the reviewer's marks survive.
      if (threadRun !== null) {
        const existing = deckForSourceThread(threadRun.source_thread_id);
        if (existing !== null && readDeckRow(existing) !== null) {
          rememberVerdictKeys(existing);
          backUpSlides(existing);
          db.prepare(`DELETE FROM slides WHERE deck_id = ?`).run(existing);
          db.prepare(
            `UPDATE decks SET title = ?, summary = ?, status = 'draft',
                              environment_id = ?, thread_id = ?, target = ?,
                              shortstat = ?, updated_at = ?
             WHERE id = ?`,
          ).run(
            title,
            summary,
            environmentId,
            ctx.threadId,
            JSON.stringify(resolved),
            shortstat,
            timestamp,
            existing,
          );
          changed();
          return JSON.stringify({
            deckId: existing,
            url: deckPath(existing),
            target: resolved,
            shortstat,
            note: "Rewriting the existing deck for this thread.",
            next: "Call review_deck_add_slide once per group of related changes.",
          });
        }
      }

      if (
        watch !== null &&
        watch.deck_id !== null &&
        readDeckRow(watch.deck_id) !== null
      ) {
        const deckId = watch.deck_id;
        rememberVerdictKeys(deckId);
        backUpSlides(deckId);
        db.prepare(`DELETE FROM slides WHERE deck_id = ?`).run(deckId);
        db.prepare(
          `UPDATE decks SET title = ?, summary = ?, status = 'draft',
                            environment_id = ?, thread_id = ?, target = ?,
                            shortstat = ?, updated_at = ?
           WHERE id = ?`,
        ).run(
          title,
          summary,
          environmentId,
          ctx.threadId,
          JSON.stringify(resolved),
          shortstat,
          timestamp,
          deckId,
        );
        changed();
        return JSON.stringify({
          deckId,
          url: deckPath(deckId),
          target: resolved,
          shortstat,
          note: "Rewriting the existing deck for this merge request.",
          next: "Call review_deck_add_slide once per group of related changes.",
        });
      }

      const deckId = `dk_${randomUUID().slice(0, 12)}`;
      db.prepare(
        `INSERT INTO decks
           (id, title, summary, status, project_id, environment_id, thread_id, target, shortstat, created_at, updated_at, watch_id, source_thread_id)
         VALUES (?, ?, ?, 'draft', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        deckId,
        title,
        summary,
        projectId ?? ctx.projectId ?? null,
        environmentId,
        ctx.threadId,
        JSON.stringify(resolved),
        shortstat,
        timestamp,
        timestamp,
        watch?.id ?? null,
        threadRun?.source_thread_id ?? null,
      );
      if (watch !== null) setWatch(watch.id, { deck_id: deckId });
      changed();
      await pruneDecks(projectId ?? ctx.projectId ?? null);
      return JSON.stringify({
        deckId,
        url: deckPath(deckId),
        target: resolved,
        shortstat,
        next: "Call review_deck_add_slide once per group of related changes.",
      });
    },
  });

  bb.agents.registerTool({
    name: "review_deck_add_slide",
    description:
      "Add one slide to a review deck. A slide covers one group of related changes: a short summary, the files that belong together, findings pinned to exact lines, and an optional diagram. Keep each slide readable in under a minute.",
    presentation: {
      label: { pending: "Adding review slide", completed: "Added review slide" },
    },
    parameters: z
      .object({
        deckId: z.string().min(1).describe("The id review_deck_create returned."),
        title: z
          .string()
          .min(1)
          .max(160)
          .describe("What this slide is about, e.g. 'New retry scheduler'."),
        kind: slideKindSchema
          .default("change")
          .describe(
            "overview for the opening slide, change for normal code, risk for danger areas, test for test coverage, wrapup for the closing slide.",
          ),
        summary: z
          .string()
          .max(4000)
          .default("")
          .describe(
            "Two or three sentences in plain language explaining this group of changes. Markdown is allowed.",
          ),
        why: z
          .string()
          .max(400)
          .optional()
          .describe("One line: why the reviewer should care about this slide."),
        files: z
          .array(slideFileSchema)
          .max(20)
          .default([])
          .describe(
            "Files shown on this slide. Give the path only — BB reads the real diff. Supply `patch` only for code that is not in the workspace diff.",
          ),
        annotations: z
          .array(annotationInputSchema)
          .max(60)
          .default([])
          .describe(
            "Findings pinned to a line. `line` is the line number on the chosen side of the diff. Write `body` as: what happens, then the impact, then whether it belongs in this change.",
          ),
        suggestions: z
          .array(suggestionSchema)
          .max(20)
          .default([])
          .describe("Points about the slide as a whole, not about one line."),
        diagram: diagramSchema
          .nullish()
          .describe(
            "Optional picture. Use kind 'flow' for how parts connect, kind 'sequence' for the order of calls between components.",
          ),
      })
      .strict(),
    execute({ deckId, ...rest }) {
      if (readDeckRow(deckId) === null) {
        return {
          content: [{ type: "text", text: `No deck with id ${deckId}.` }],
          isError: true,
        };
      }
      const slide = insertSlide(deckId, slideInputSchema.parse(rest));
      return JSON.stringify({
        slideId: slide.id,
        position: slide.position,
        annotationIds: slide.annotations.map((item) => item.id),
      });
    },
  });

  bb.agents.registerTool({
    name: "review_deck_read",
    description:
      "Read a review deck as it stands: its slides with their positions and ids, and every finding with its id, line and severity. Call this before editing a deck so you reference real ids. With no deckId it reads the deck this thread is about.",
    instructions:
      "When the user asks you to change something about a review deck, use review_deck_read then review_deck_edit — do not build a new deck.",
    presentation: {
      label: { pending: "Reading the review deck", completed: "Read the review deck" },
    },
    parameters: z
      .object({
        deckId: z
          .string()
          .nullish()
          .describe("Omit to read the deck this thread is about."),
      })
      .strict(),
    execute({ deckId }, ctx) {
      const target = deckId ?? deckForContext(ctx.threadId);
      if (target === null) {
        return {
          content: [
            {
              type: "text",
              text: "This thread is not about a review deck. Pass a deckId, or run `bb review-deck list`.",
            },
          ],
          isError: true,
        };
      }
      const deck = readDeck(target);
      if (deck === null) {
        return {
          content: [{ type: "text", text: `No deck with id ${target}.` }],
          isError: true,
        };
      }
      return JSON.stringify(
        {
          deckId: deck.id,
          title: deck.title,
          summary: deck.summary,
          status: deck.status,
          slides: deck.slides.map((slide) => ({
            slideId: slide.id,
            position: slide.position,
            title: slide.title,
            kind: slide.kind,
            summary: slide.summary,
            why: slide.why,
            files: slide.files.map((file) => file.path),
            diagram: slide.diagram === null ? null : slide.diagram.kind,
            reviewerVerdict: slide.state,
            reviewerNote: slide.note,
            findings: slide.annotations.map((item) => ({
              findingId: item.id,
              severity: item.severity,
              path: item.path,
              line: item.line,
              title: item.title,
              reviewerVerdict: deck.verdicts[item.id]?.verdict ?? "open",
              reviewerNote: deck.verdicts[item.id]?.note ?? "",
            })),
          })),
        },
        null,
        2,
      );
    },
  });

  bb.agents.registerTool({
    name: "review_deck_edit",
    description:
      "Change a review deck that already exists: reword or remove a slide, add or drop a finding, fix a severity or a line number, reorder slides. Read the deck first so you use real ids. The reviewer's Agree/Disagree answers stay attached to findings you edit, and are dropped with findings you remove.",
    presentation: {
      label: {
        pending: "Editing the review deck",
        completed: "Edited the review deck",
      },
    },
    parameters: z
      .object({
        deckId: z
          .string()
          .nullish()
          .describe("Omit to edit the deck this thread is about."),
        operations: z
          .array(deckOperationSchema)
          .min(1)
          .max(40)
          .describe(
            "Applied in order. A slide is named by its `slideId` or by the position the reviewer sees; a finding by its `findingId`.",
          ),
      })
      .strict(),
    execute({ deckId, operations }, ctx) {
      const target = deckId ?? deckForContext(ctx.threadId);
      if (target === null) {
        return {
          content: [
            {
              type: "text",
              text: "This thread is not about a review deck. Pass a deckId.",
            },
          ],
          isError: true,
        };
      }
      if (readDeckRow(target) === null) {
        return {
          content: [{ type: "text", text: `No deck with id ${target}.` }],
          isError: true,
        };
      }
      const done = applyDeckOperations(target, operations);
      return JSON.stringify({
        deckId: target,
        applied: done,
        note: "The reviewer sees this straight away; the open deck refreshes itself.",
      });
    },
  });

  bb.agents.registerTool({
    name: "review_deck_finish",
    description:
      "Mark a review deck as ready for the human reviewer and get the link to it. Call this once every slide is added.",
    presentation: {
      label: { pending: "Finishing review deck", completed: "Review deck ready" },
    },
    parameters: z
      .object({
        deckId: z.string().min(1),
        summary: z
          .string()
          .max(4000)
          .optional()
          .describe("Replaces the deck summary when the review changed it."),
      })
      .strict(),
    async execute({ deckId, summary }) {
      const row = readDeckRow(deckId);
      if (row === null) {
        return {
          content: [{ type: "text", text: `No deck with id ${deckId}.` }],
          isError: true,
        };
      }
      db.prepare(
        `UPDATE decks SET status = 'ready', summary = ?, updated_at = ? WHERE id = ?`,
      ).run(summary ?? row.summary, now(), deckId);
      dropOrphanedMarks(deckId);
      discardBackup(deckId);
      await snapshotPatches(deckId);
      changed();
      const deck = readDeck(deckId);
      const slideCount = deck?.slideCount ?? 0;
      const blockers = deck?.blockerCount ?? 0;
      return JSON.stringify({
        deckId,
        url: deckPath(deckId),
        slideCount,
        blockerCount: blockers,
        tellTheUser: `The review deck is ready: ${slideCount} slide${slideCount === 1 ? "" : "s"}${blockers > 0 ? `, ${blockers} blocker${blockers === 1 ? "" : "s"}` : ""}. Open it from the Review Deck page in the sidebar.`,
      });
    },
  });

  // -------------------------------------------------------------------------
  // CLI
  // -------------------------------------------------------------------------

  const usage = [
    "Usage:",
    "  bb review-deck list [--json]",
    "  bb review-deck show <deck-id> [--json]",
    "  bb review-deck files [--json]",
    "  bb review-deck create --file <path-to-deck.json> [--json]",
    "  bb review-deck notes <deck-id>",
    "  bb review-deck delete <deck-id>",
    "",
    "Watched merge requests (re-reviewed on every push):",
    "  bb review-deck watch <merge-request-url> [--prompt \"...\"]",
    "  bb review-deck watches [--json]",
    "  bb review-deck review <watch-id>",
    "  bb review-deck unwatch <watch-id>",
    "",
    "This thread's own changes:",
    "  bb review-deck review-thread [--prompt \"...\"]",
    "",
    "  bb review-deck post <deck-id>           Post agreed findings to the MR",
    "  bb review-deck poll                     Check every watch now",
    "",
    "The deck.json file holds { title, summary?, target?, slides: [...] }.",
    "Prefer the review_deck_* tools inside a BB thread; this command is for",
    "scripts and for agents whose provider has no native tools.",
  ].join("\n");

  const deckFileSchema = z.object({
    title: z.string().min(1).max(160),
    summary: z.string().max(4000).default(""),
    target: diffTargetSchema.nullish(),
    slides: z.array(slideInputSchema).min(1).max(40),
  });

  bb.cli.register({
    name: "review-deck",
    summary: "Build and read guided code-review slide decks",
    commands: [
      {
        name: "list",
        summary: "List review decks",
        usage: "bb review-deck list [--json]",
      },
      {
        name: "show",
        summary: "Show a deck's slides",
        usage: "bb review-deck show <deck-id> [--json]",
      },
      {
        name: "files",
        summary: "List the changed files in this thread's workspace",
        usage: "bb review-deck files [--json]",
      },
      {
        name: "create",
        summary: "Create a whole deck from a JSON file",
        usage: "bb review-deck create --file <path-to-deck.json> [--json]",
      },
      {
        name: "notes",
        summary: "Print the reviewer's notes as markdown",
        usage: "bb review-deck notes <deck-id>",
      },
      {
        name: "delete",
        summary: "Delete a deck",
        usage: "bb review-deck delete <deck-id>",
      },
      {
        name: "watch",
        summary:
          "Watch a merge request and keep its review deck up to date on every push",
        usage: 'bb review-deck watch <merge-request-url> [--prompt "..."]',
      },
      {
        name: "watches",
        summary: "List watched merge requests",
        usage: "bb review-deck watches [--json]",
      },
      {
        name: "review",
        summary: "Review a watched merge request now",
        usage: "bb review-deck review <watch-id>",
      },
      {
        name: "unwatch",
        summary: "Stop watching a merge request",
        usage: "bb review-deck unwatch <watch-id>",
      },
      {
        name: "post",
        summary:
          "Post the findings you agreed with to the merge request, on their lines",
        usage: "bb review-deck post <deck-id>",
      },
      {
        name: "poll",
        summary:
          "Check every watched merge request for new commits right now",
        usage: "bb review-deck poll",
      },
      {
        name: "review-thread",
        summary:
          "Review this thread's own changes and build a deck from them",
        usage: 'bb review-deck review-thread [--prompt "..."]',
      },
    ],
    async run(argv, ctx) {
      const json = argv.includes("--json");
      const args = argv.filter((arg) => arg !== "--json");
      const [command, ...rest] = args;
      const reply = (value: unknown, text: string) => ({
        exitCode: 0,
        stdout: json ? JSON.stringify(value, null, 2) : text,
      });

      switch (command) {
        case undefined:
        case "help":
        case "--help":
          return { exitCode: 0, stdout: usage };

        case "list": {
          const decks = listDecks(ctx.projectId ?? null);
          return reply(
            decks,
            decks.length === 0
              ? "No review decks yet."
              : decks
                  .map(
                    (deck) =>
                      `${deck.id}  ${deck.status.padEnd(5)}  ${String(deck.slideCount).padStart(2)} slides  ${deck.title}`,
                  )
                  .join("\n"),
          );
        }

        case "show": {
          const deckId = rest[0];
          if (deckId === undefined) break;
          const deck = readDeck(deckId);
          if (deck === null) {
            return { exitCode: 1, stderr: `No deck with id ${deckId}.` };
          }
          const text = [
            `${deck.title}  (${deck.status})`,
            deck.shortstat === "" ? null : deck.shortstat,
            "",
            ...deck.slides.map(
              (slide) =>
                `${String(slide.position).padStart(2)}. [${slide.kind}] ${slide.title}` +
                `  — ${slide.annotations.length} finding${slide.annotations.length === 1 ? "" : "s"}, ${stateLabel[slide.state]}`,
            ),
            "",
            `Open it at ${deckPath(deck.id)}`,
          ]
            .filter((line) => line !== null)
            .join("\n");
          return reply(deck, text);
        }

        case "files": {
          const { environmentId } = await environmentForThread(ctx.threadId);
          if (environmentId === null) {
            return {
              exitCode: 1,
              stderr:
                "No workspace for this thread. Run this from a thread with an environment.",
            };
          }
          const target = await defaultTarget(environmentId);
          const diff = await readChangedFiles(environmentId, target);
          if (!diff.ok) {
            return { exitCode: 1, stderr: diff.message || "Could not read the diff." };
          }
          return reply(
            { target, shortstat: diff.shortstat, files: diff.files },
            [
              diff.shortstat,
              ...diff.files.map(
                (file) =>
                  `  ${file.changeKind.padEnd(9)} +${String(file.additions).padStart(4)} -${String(file.deletions).padStart(4)}  ${file.path}`,
              ),
            ].join("\n"),
          );
        }

        case "create": {
          const flagIndex = rest.indexOf("--file");
          const filePath = flagIndex === -1 ? undefined : rest[flagIndex + 1];
          if (filePath === undefined) break;
          // `run` executes on the server, so the path names a file on the
          // machine that typed the command. Read it through bb.sdk.files with
          // that machine's hostId, never with node:fs.
          const { environmentId, projectId } = await environmentForThread(
            ctx.threadId,
          );
          let hostId: string | undefined;
          if (environmentId !== null) {
            try {
              hostId = (await bb.sdk.environments.get({ environmentId })).hostId;
            } catch {
              hostId = undefined;
            }
          }
          let raw: string;
          try {
            const file = await bb.sdk.files.read({
              hostId,
              path: filePath.startsWith("/")
                ? filePath
                : `${ctx.cwd ?? "."}/${filePath}`,
            });
            raw =
              file.contentEncoding === "base64"
                ? Buffer.from(file.content, "base64").toString("utf8")
                : file.content;
          } catch (cause) {
            return {
              exitCode: 1,
              stderr: `Could not read ${filePath}: ${cause instanceof Error ? cause.message : String(cause)}`,
            };
          }
          let parsed;
          try {
            parsed = deckFileSchema.parse(JSON.parse(raw));
          } catch (cause) {
            return {
              exitCode: 1,
              stderr: `${filePath} is not a valid deck file: ${cause instanceof Error ? cause.message : String(cause)}`,
            };
          }
          const target =
            parsed.target ?? (await defaultTarget(environmentId ?? null));
          let shortstat = "";
          if (environmentId !== null) {
            shortstat = (await readChangedFiles(environmentId, target)).shortstat;
          }
          const deckId = `dk_${randomUUID().slice(0, 12)}`;
          const timestamp = now();
          db.prepare(
            `INSERT INTO decks
               (id, title, summary, status, project_id, environment_id, thread_id, target, shortstat, created_at, updated_at)
             VALUES (?, ?, ?, 'ready', ?, ?, ?, ?, ?, ?, ?)`,
          ).run(
            deckId,
            parsed.title,
            parsed.summary,
            projectId ?? ctx.projectId ?? null,
            environmentId,
            ctx.threadId ?? null,
            JSON.stringify(target),
            shortstat,
            timestamp,
            timestamp,
          );
          for (const slide of parsed.slides) insertSlide(deckId, slide);
          changed();
          await pruneDecks(projectId ?? ctx.projectId ?? null);
          return reply(
            { deckId, url: deckPath(deckId), slideCount: parsed.slides.length },
            `Created ${deckId} with ${parsed.slides.length} slides. Open it at ${deckPath(deckId)}`,
          );
        }

        case "notes": {
          const deckId = rest[0];
          if (deckId === undefined) break;
          const deck = readDeck(deckId);
          if (deck === null) {
            return { exitCode: 1, stderr: `No deck with id ${deckId}.` };
          }
          return { exitCode: 0, stdout: notesMarkdown(deck) };
        }

        case "delete": {
          const deckId = rest[0];
          if (deckId === undefined) break;
          if (!deleteDeck(deckId)) {
            return { exitCode: 1, stderr: `No deck with id ${deckId}.` };
          }
          return reply({ removed: true, deckId }, `Deleted ${deckId}.`);
        }

        case "watch": {
          const promptIndex = rest.indexOf("--prompt");
          // Skip the flag's value, but only when the flag is actually present:
          // `promptIndex + 1` is 0 otherwise, which would skip the URL itself.
          const promptValueAt = promptIndex === -1 ? -1 : promptIndex + 1;
          const url = rest.find(
            (arg, position) =>
              !arg.startsWith("--") && position !== promptValueAt,
          );
          if (url === undefined) break;
          const prompt =
            promptIndex === -1 ? undefined : rest[promptIndex + 1];
          const result = await addWatch({ url, prompt });
          return result.ok
            ? reply(result, result.message)
            : { exitCode: 1, stderr: result.message };
        }

        case "watches": {
          const rows = readWatchRows();
          await loadProjectNames(rows);
          const watches = rows.map(toWatch);
          return reply(
            watches,
            watches.length === 0
              ? "No watched merge requests."
              : watches
                  .map(
                    (watch) =>
                      `${watch.id}  ${watch.state.padEnd(7)} !${String(watch.iid).padEnd(5)} ` +
                      `${watch.deckId ?? "no deck".padEnd(15)}  ${watch.title}` +
                      (watch.lastError === null ? "" : `\n    error: ${watch.lastError}`),
                  )
                  .join("\n"),
          );
        }

        case "review": {
          const watchId = rest[0];
          if (watchId === undefined) break;
          const result = await startReview(watchId, { force: true });
          return result.started
            ? reply(result, result.message)
            : { exitCode: 1, stderr: result.message };
        }

        case "post": {
          const deckId = rest[0];
          if (deckId === undefined) break;
          const result = await postDeckToMr(deckId);
          const text = [
            result.message,
            ...result.failed.map((f) => `  ! ${f.title}: ${f.reason}`),
          ].join("\n");
          return result.posted > 0 || result.failed.length === 0
            ? reply(result, text)
            : { exitCode: 1, stderr: text };
        }

        case "poll": {
          await pollWatches();
          const rows = readWatchRows();
          await loadProjectNames(rows);
          const watches = rows.map(toWatch);
          return reply(
            watches,
            watches.length === 0
              ? "No watched merge requests."
              : watches
                  .map((w) => `!${w.iid} ${w.state}  ${w.title}`)
                  .join("\n"),
          );
        }

        case "review-thread": {
          if (ctx.threadId === undefined) {
            return {
              exitCode: 1,
              stderr: "Run this from inside a BB thread that has a workspace.",
            };
          }
          const promptIndex = rest.indexOf("--prompt");
          const result = await startThreadReview(
            ctx.threadId,
            promptIndex === -1 ? undefined : rest[promptIndex + 1],
          );
          return result.started
            ? reply(result, result.message)
            : { exitCode: 1, stderr: result.message };
        }

        case "unwatch": {
          const watchId = rest[0];
          if (watchId === undefined) break;
          const removed = db
            .prepare(`DELETE FROM watches WHERE id = ?`)
            .run(watchId);
          if (removed.changes === 0) {
            return { exitCode: 1, stderr: `No watch with id ${watchId}.` };
          }
          watchChanged();
          return reply({ removed: true, watchId }, `Stopped watching ${watchId}.`);
        }
      }
      return { exitCode: 1, stderr: usage };
    },
  });

  // Checking for new commits. The cron runs only while the plugin is loaded,
  // which is exactly when there is a UI to update.
  const { pollMinutes } = await settings.get();
  const minutes = Number.parseInt(pollMinutes, 10);
  const every = Number.isFinite(minutes) && minutes >= 1 && minutes <= 59 ? minutes : 5;
  bb.background.schedule("poll-merge-requests", `*/${every} * * * *`, async () => {
    await pollWatches();
  });

  bb.log.info(`review-deck loaded; watching merge requests every ${every}m`);
}
