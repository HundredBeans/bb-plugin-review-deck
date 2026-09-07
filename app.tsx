// bb-plugin-review-deck — frontend entry.
//
// Two surfaces over the same deck: a full page in the sidebar, and a tab in a
// thread's side panel so you can walk the review while the agent is still
// there to answer.
import { useCallback, useEffect, useMemo, useState } from "react";
import type { FormEvent } from "react";
import {
  definePluginApp,
  Markdown,
  ThreadChat,
  UrlLink,
  useBbNavigate,
  useRealtime,
  useRpc,
} from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";
import type {
  AnnotationVerdict,
  Deck,
  DeckSummary,
  ReviewState,
  Watch,
} from "@/lib/deck-schema";
import type { rpcContract } from "@/server";
import { PromptField } from "@/components/prompt-field";
import { SlideView } from "@/components/slide-view";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

const PANEL_PATH = "review";

// ---------------------------------------------------------------------------
// Data
// ---------------------------------------------------------------------------

function useDecks() {
  const rpc = useRpc<typeof rpcContract>();
  const [decks, setDecks] = useState<DeckSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const refetch = useCallback(() => {
    rpc.call("decks_list", {}).then(
      (result) => {
        setDecks(result.decks as DeckSummary[]);
        setError(null);
      },
      (cause: unknown) =>
        setError(cause instanceof Error ? cause.message : String(cause)),
    );
  }, [rpc]);
  useEffect(refetch, [refetch]);
  useRealtime("decks-changed", refetch);
  return { decks, error, refetch, rpc };
}

function useDeck(deckId: string | null) {
  const rpc = useRpc<typeof rpcContract>();
  const [deck, setDeck] = useState<Deck | null>(null);
  const [error, setError] = useState<string | null>(null);
  const refetch = useCallback(() => {
    if (deckId === null) {
      setDeck(null);
      return;
    }
    rpc.call("deck_get", { deckId }).then(
      (result) => {
        setDeck(result.deck as Deck);
        setError(null);
      },
      (cause: unknown) =>
        setError(cause instanceof Error ? cause.message : String(cause)),
    );
  }, [rpc, deckId]);
  useEffect(refetch, [refetch]);
  // The agent writes slides one at a time — keep an open deck current.
  useRealtime("decks-changed", refetch);
  return { deck, error, refetch, rpc };
}

// ---------------------------------------------------------------------------
// Small pieces
// ---------------------------------------------------------------------------

function EmptyState({ children }: { children: React.ReactNode }) {
  return (
    <div
      role="status"
      className="rounded-lg border border-dashed border-border px-4 py-8 text-center text-sm text-muted-foreground"
    >
      {children}
    </div>
  );
}

/**
 * Open the thread doing a review, with the deck beside it.
 *
 * The panel can only be opened once the thread surface is showing, so it is
 * asked for on the next frame rather than in the same tick as the navigation.
 */
function useWatchTheAgent() {
  const navigate = useBbNavigate();
  return useCallback(
    (threadId: string) => {
      navigate.toThread(threadId);
      requestAnimationFrame(() => {
        navigate.openThreadPanel({
          actionId: "thread-deck",
          title: "Review deck",
        });
      });
    },
    [navigate],
  );
}

function ProgressDots({
  deck,
  index,
  onPick,
}: {
  deck: Deck;
  index: number;
  onPick: (next: number) => void;
}) {
  return (
    <ol className="flex flex-wrap items-center gap-1">
      {deck.slides.map((slide, position) => {
        const active = position === index;
        const blocker = slide.annotations.some(
          (item) => item.severity === "blocker",
        );
        return (
          <li key={slide.id}>
            <button
              type="button"
              onClick={() => onPick(position)}
              title={`${position + 1}. ${slide.title}`}
              aria-current={active ? "step" : undefined}
              className={cn(
                "h-1.5 w-7 rounded-full transition-colors",
                active
                  ? "bg-foreground"
                  : slide.state === "approved"
                    ? "bg-primary/60"
                    : slide.state === "needs-work"
                      ? "bg-destructive/60"
                      : blocker
                        ? "bg-destructive/30"
                        : "bg-border hover:bg-muted-foreground/40",
              )}
            >
              <span className="sr-only">
                Slide {position + 1}: {slide.title}
              </span>
            </button>
          </li>
        );
      })}
    </ol>
  );
}

// ---------------------------------------------------------------------------
// The deck viewer
// ---------------------------------------------------------------------------

function DeckViewer({
  deckId,
  index,
  onIndex,
  onClose,
  compact = false,
  chatOpen,
  onToggleChat,
}: {
  deckId: string;
  index: number;
  onIndex: (next: number) => void;
  onClose?: () => void;
  compact?: boolean;
  chatOpen?: boolean;
  onToggleChat?: () => void;
}) {
  const { deck, error, refetch, rpc } = useDeck(deckId);
  const total = deck?.slides.length ?? 0;
  const safeIndex = total === 0 ? 0 : Math.min(Math.max(index, 0), total - 1);
  const slide = deck?.slides[safeIndex];

  const go = useCallback(
    (next: number) => {
      if (total === 0) return;
      onIndex(Math.min(Math.max(next, 0), total - 1));
    },
    [onIndex, total],
  );

  // ← and → walk the deck, unless you are typing.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const tag = target?.tagName;
      if (
        tag === "INPUT" ||
        tag === "TEXTAREA" ||
        target?.isContentEditable === true
      ) {
        return;
      }
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      if (event.key === "ArrowRight") {
        event.preventDefault();
        go(safeIndex + 1);
      } else if (event.key === "ArrowLeft") {
        event.preventDefault();
        go(safeIndex - 1);
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [go, safeIndex]);

  const setState = (state: ReviewState, note: string) => {
    if (slide === undefined || deck === null) return;
    rpc
      .call("slide_set_state", { deckId: deck.id, slideId: slide.id, state, note })
      .then(refetch, (cause: unknown) => toast.error(String(cause)));
  };

  const setVerdict = (
    annotationId: string,
    verdict: AnnotationVerdict,
    note: string,
  ) => {
    if (deck === null) return;
    rpc
      .call("annotation_set_verdict", {
        deckId: deck.id,
        annotationId,
        verdict,
        note,
      })
      .then(refetch, (cause: unknown) => toast.error(String(cause)));
  };

  const copyNotes = () => {
    rpc.call("deck_notes", { deckId }).then(
      async ({ markdown }) => {
        try {
          await navigator.clipboard.writeText(markdown);
          toast.success("Review notes copied.");
        } catch {
          toast.error("Could not reach the clipboard.");
        }
      },
      (cause: unknown) => toast.error(String(cause)),
    );
  };

  if (error !== null) {
    return (
      <p role="alert" className="text-sm text-destructive">
        {error}
      </p>
    );
  }
  if (deck === null) return <EmptyState>Loading the deck…</EmptyState>;

  return (
    <div className="space-y-4">
      <div className="sticky top-0 z-10 -mx-1 space-y-2 bg-background/95 px-1 pb-2 pt-1 backdrop-blur">
        <div className="flex items-center gap-2">
          {onClose === undefined ? null : (
            <Button
              variant="ghost"
              size="sm"
              className="h-7 shrink-0 px-2 text-xs text-muted-foreground"
              onClick={onClose}
            >
              <Icon name="ChevronLeft" className="size-3.5" />
              All decks
            </Button>
          )}
          <h1 className="min-w-0 flex-1 truncate text-sm font-semibold text-foreground">
            {deck.title}
          </h1>
          {deck.status === "draft" ? (
            <span className="shrink-0 rounded-full border border-border bg-muted px-2 py-0.5 text-[11px] leading-none text-muted-foreground">
              Draft
            </span>
          ) : null}
        </div>

        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            className="h-7 shrink-0 px-2"
            disabled={safeIndex === 0}
            onClick={() => go(safeIndex - 1)}
            aria-label="Previous slide"
          >
            <Icon name="ChevronLeft" className="size-4" />
          </Button>
          <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
            {total === 0 ? 0 : safeIndex + 1} / {total}
          </span>
          <Button
            variant="outline"
            size="sm"
            className="h-7 shrink-0 px-2"
            disabled={total === 0 || safeIndex >= total - 1}
            onClick={() => go(safeIndex + 1)}
            aria-label="Next slide"
          >
            <Icon name="ChevronRight" className="size-4" />
          </Button>
          <div className="min-w-0 flex-1 overflow-hidden">
            <ProgressDots deck={deck} index={safeIndex} onPick={go} />
          </div>
          {compact ? null : (
            <>
              {onToggleChat === undefined ? null : (
                <Button
                  variant={chatOpen === true ? "secondary" : "ghost"}
                  size="sm"
                  className="h-7 shrink-0 px-2 text-xs"
                  onClick={onToggleChat}
                >
                  <Icon name="MessageSquare" className="size-3.5" />
                  Chat
                </Button>
              )}
              <Button
                variant="ghost"
                size="sm"
                className="h-7 shrink-0 px-2 text-xs text-muted-foreground"
                onClick={copyNotes}
              >
                <Icon name="Copy" className="size-3.5" />
                Copy notes
              </Button>

            </>
          )}
        </div>
      </div>

      {deck.status === "draft" ? (
        <p className="flex items-center gap-2 rounded-lg border border-primary/40 bg-primary/10 px-3 py-2 text-[13px] text-primary">
          <Icon name="Loading" className="size-3.5 shrink-0" />
          The agent is still writing this deck — {total} slide
          {total === 1 ? "" : "s"} so far. New slides appear as they land.
        </p>
      ) : null}

      {safeIndex === 0 && deck.summary.trim() !== "" ? (
        <section className="rounded-lg border border-border bg-card px-3.5 py-3">
          <h2 className="mb-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">
            The change in short
          </h2>
          <div className="text-sm leading-relaxed text-foreground">
            <Markdown content={deck.summary} />
          </div>
          {deck.shortstat === "" ? null : (
            <p className="mt-2 font-mono text-[11px] text-muted-foreground">
              {deck.shortstat}
            </p>
          )}
        </section>
      ) : null}

      {slide === undefined ? (
        <EmptyState>
          This deck has no slides yet. The agent may still be writing it.
        </EmptyState>
      ) : (
        <SlideView
          key={slide.id}
          deck={deck}
          slide={slide}
          onState={setState}
          onVerdict={setVerdict}
          onAsk={
            onToggleChat === undefined
              ? undefined
              : () => {
                  if (chatOpen !== true) onToggleChat();
                  rpc
                    .call("deck_discuss_slide", { deckId, slideId: slide.id })
                    .then(
                      (result) =>
                        result.ok
                          ? toast.success(result.message)
                          : toast.error(result.message),
                      (cause: unknown) => toast.error(String(cause)),
                    );
                }
          }
        />
      )}

      {total > 0 ? (
        <div className="flex items-center justify-between gap-2 border-t border-border pt-3">
          <Button
            variant="outline"
            size="sm"
            className="h-8"
            disabled={safeIndex === 0}
            onClick={() => go(safeIndex - 1)}
          >
            <Icon name="ChevronLeft" className="size-4" />
            Previous
          </Button>
          <span className="text-xs text-muted-foreground">
            Use ← and → to move between slides
          </span>
          <Button
            variant="outline"
            size="sm"
            className="h-8"
            disabled={safeIndex >= total - 1}
            onClick={() => go(safeIndex + 1)}
          >
            Next
            <Icon name="ChevronRight" className="size-4" />
          </Button>
        </div>
      ) : null}

      {total > 0 && safeIndex >= total - 1 ? (
        <NextSteps deckId={deckId} onCopy={copyNotes} />
      ) : null}
    </div>
  );
}

/** Attach a deck that already exists to the thread you are in. */
function AttachDeck({
  threadId,
  onAttached,
}: {
  threadId: string;
  onAttached: () => void;
}) {
  const rpc = useRpc<typeof rpcContract>();
  const [open, setOpen] = useState(false);
  const [decks, setDecks] = useState<DeckSummary[] | null>(null);

  useEffect(() => {
    if (!open) return;
    rpc.call("decks_list", {}).then(
      (result) => setDecks(result.decks as DeckSummary[]),
      () => setDecks([]),
    );
  }, [open, rpc]);

  if (!open) {
    return (
      <Button
        variant="ghost"
        size="sm"
        className="h-7 px-2 text-xs text-muted-foreground"
        onClick={() => setOpen(true)}
      >
        <Icon name="Folder" className="size-3.5" />
        Attach an existing deck
      </Button>
    );
  }

  return (
    <div className="rounded-lg border border-border bg-card px-3 py-2">
      <div className="flex items-center gap-2">
        <span className="min-w-0 flex-1 text-[13px] text-foreground">
          Which deck is this thread about?
        </span>
        <Button
          variant="ghost"
          size="icon"
          className="size-6 text-muted-foreground"
          aria-label="Cancel"
          onClick={() => setOpen(false)}
        >
          <Icon name="X" className="size-3.5" />
        </Button>
      </div>
      {decks === null ? (
        <p className="mt-2 text-[12px] text-muted-foreground">Loading…</p>
      ) : decks.length === 0 ? (
        <p className="mt-2 text-[12px] text-muted-foreground">No decks yet.</p>
      ) : (
        <ul className="mt-2 max-h-56 list-none space-y-1 overflow-y-auto">
          {decks.map((deck) => (
            <li key={deck.id}>
              <button
                type="button"
                className="block w-full rounded border-0 bg-transparent px-2 py-1.5 text-left hover:bg-accent"
                onClick={() => {
                  rpc
                    .call("deck_attach", { deckId: deck.id, threadId })
                    .then(
                      () => {
                        toast.success("Deck attached to this thread.");
                        setOpen(false);
                        onAttached();
                      },
                      (cause: unknown) => toast.error(String(cause)),
                    );
                }}
              >
                <span className="block truncate text-[13px] text-foreground">
                  {deck.title}
                </span>
                <span className="block text-[11px] text-muted-foreground">
                  {deck.slideCount} slide{deck.slideCount === 1 ? "" : "s"},{" "}
                  {deck.annotationCount} finding
                  {deck.annotationCount === 1 ? "" : "s"}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** BB's real chat, beside the deck, on a conversation that belongs to it. */
function DeckChat({
  deckId,
  onClose,
  className,
}: {
  deckId: string;
  onClose: () => void;
  className?: string;
}) {
  const rpc = useRpc<typeof rpcContract>();
  const [threadId, setThreadId] = useState<string | null | undefined>(undefined);
  const [busy, setBusy] = useState(false);

  const refetch = useCallback(() => {
    rpc.call("deck_next_actions", { deckId }).then(
      (result) => setThreadId(result.discussionThreadId),
      () => setThreadId(null),
    );
  }, [rpc, deckId]);
  useEffect(refetch, [refetch]);
  useRealtime("decks-changed", refetch);

  const start = () => {
    setBusy(true);
    rpc
      .call("deck_act", { deckId, intent: "ask" })
      .then(
        (result) => {
          if (result.ok && result.threadId !== null) setThreadId(result.threadId);
          else toast.error(result.message);
        },
        (cause: unknown) => toast.error(String(cause)),
      )
      .finally(() => setBusy(false));
  };

  return (
    <aside className={cn("flex min-h-0 flex-col border-border", className)}>
      <header className="flex shrink-0 items-center gap-2 border-b border-border px-3 py-2">
        <Icon name="MessageSquare" className="size-3.5 text-muted-foreground" />
        <span className="min-w-0 flex-1 truncate text-xs font-medium text-foreground">
          Chat about this review
        </span>
        <Button
          variant="ghost"
          size="icon"
          className="size-6 text-muted-foreground"
          aria-label="Close the chat"
          onClick={onClose}
        >
          <Icon name="X" className="size-3.5" />
        </Button>
      </header>

      {threadId === undefined ? (
        <p className="p-4 text-center text-sm text-muted-foreground">Loading…</p>
      ) : threadId === null ? (
        <div className="p-4">
          <p className="text-[13px] text-foreground">
            Ask about anything in this deck.
          </p>
          <p className="mt-1 text-[11px] text-muted-foreground">
            The agent gets the deck and works in the right workspace, so it can
            read the code to answer. It will not summarise, suggest next steps,
            or change anything unless you ask.
          </p>
          <Button
            size="sm"
            className="mt-3 h-8"
            disabled={busy}
            onClick={start}
          >
            <Icon name="MessageSquare" className="size-4" />
            {busy ? "Starting…" : "Start the chat"}
          </Button>
        </div>
      ) : (
        <div className="min-h-0 flex-1">
          <ThreadChat threadId={threadId} variant="compact" layout="contained" />
        </div>
      )}
    </aside>
  );
}

/** What to do once you have been through the deck. */
function NextSteps({ deckId, onCopy }: { deckId: string; onCopy: () => void }) {
  const rpc = useRpc<typeof rpcContract>();
  const navigate = useBbNavigate();
  const [info, setInfo] = useState<{
    agreedCount: number;
    openCount: number;
    canPostToMr: boolean;
    mrLabel: string | null;
    replyThreadId: string | null;
    discussionThreadId: string | null;
  } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [confirmPost, setConfirmPost] = useState(false);

  const refetch = useCallback(() => {
    rpc.call("deck_next_actions", { deckId }).then(setInfo, () => setInfo(null));
  }, [rpc, deckId]);
  useEffect(refetch, [refetch]);
  useRealtime("decks-changed", refetch);

  const act = (intent: "discuss" | "fix") => {
    setBusy(intent);
    rpc
      .call("deck_act", { deckId, intent })
      .then(
        (result) => {
          if (result.ok && result.threadId !== null) {
            toast.success(result.message);
            navigate.toThread(result.threadId);
          } else {
            toast.error(result.message);
          }
        },
        (cause: unknown) => toast.error(String(cause)),
      )
      .finally(() => setBusy(null));
  };

  const post = () => {
    setBusy("post");
    setConfirmPost(false);
    rpc
      .call("deck_post_to_mr", { deckId })
      .then(
        (result) => {
          if (result.failed.length > 0) toast.error(result.message);
          else toast.success(result.message);
          for (const failure of result.failed) {
            toast.error(`${failure.title}: ${failure.reason}`);
          }
        },
        (cause: unknown) => toast.error(String(cause)),
      )
      .finally(() => setBusy(null));
  };

  const agreed = info?.agreedCount ?? 0;
  const open = info?.openCount ?? 0;

  return (
    <section className="rounded-lg border border-border bg-card px-3.5 py-3">
      <h2 className="text-sm font-medium text-foreground">
        That is the whole deck. What now?
      </h2>
      <p className="mt-1 text-[12px] text-muted-foreground">
        {agreed === 0
          ? "You have not agreed with any finding yet. Mark the ones you want acted on — they are what the buttons below work from."
          : `${agreed} finding${agreed === 1 ? "" : "s"} you agreed with` +
            (open === 0 ? "." : `, ${open} still unanswered.`)}
      </p>

      <div className="mt-3 flex flex-wrap gap-2">
        <Button
          size="sm"
          className="h-8"
          disabled={busy !== null}
          onClick={() => act("discuss")}
        >
          <Icon name="MessageSquare" className="size-4" />
          {busy === "discuss"
            ? "Sending…"
            : info?.discussionThreadId == null
              ? "Talk it through with an agent"
              : "Send my notes to the chat"}
        </Button>

        <Button
          variant="outline"
          size="sm"
          className="h-8"
          disabled={busy !== null || agreed === 0}
          onClick={() => act("fix")}
        >
          <Icon name="Edit" className="size-4" />
          {busy === "fix"
            ? "Opening…"
            : `Fix the ${agreed} agreed finding${agreed === 1 ? "" : "s"}`}
        </Button>

        {info?.canPostToMr === true ? (
          confirmPost ? (
            <>
              <Button
                variant="destructive"
                size="sm"
                className="h-8"
                disabled={busy !== null}
                onClick={post}
              >
                <Icon name="Check" className="size-4" />
                Yes, post {agreed} to {info.mrLabel}
              </Button>
              <Button
                variant="ghost"
                size="sm"
                className="h-8"
                onClick={() => setConfirmPost(false)}
              >
                Cancel
              </Button>
            </>
          ) : (
            <Button
              variant="outline"
              size="sm"
              className="h-8"
              disabled={busy !== null || agreed === 0}
              onClick={() => setConfirmPost(true)}
            >
              <Icon name="Workflow" className="size-4" />
              {busy === "post"
                ? "Posting…"
                : `Post to ${info.mrLabel} as inline comments`}
            </Button>
          )
        ) : null}

        {info?.replyThreadId == null ? null : (
          <Button
            variant="outline"
            size="sm"
            className="h-8"
            disabled={busy !== null}
            onClick={() => {
              setBusy("reply");
              rpc
                .call("deck_send_notes", { deckId })
                .then(
                  (result) => {
                    if (!result.sent) {
                      toast.error(result.message);
                      return;
                    }
                    toast.success(result.message);
                    if (result.threadId !== null) navigate.toThread(result.threadId);
                  },
                  (cause: unknown) => toast.error(String(cause)),
                )
                .finally(() => setBusy(null));
            }}
          >
            <Icon name="Bot" className="size-4" />
            {busy === "reply" ? "Sending…" : "Reply in the original thread"}
          </Button>
        )}

        <Button
          variant="ghost"
          size="sm"
          className="h-8 text-muted-foreground"
          onClick={onCopy}
        >
          <Icon name="Copy" className="size-4" />
          Copy notes
        </Button>
      </div>

      {confirmPost ? (
        <p className="mt-2 text-[12px] text-destructive">
          This writes {agreed} comment{agreed === 1 ? "" : "s"} onto{" "}
          {info?.mrLabel}, each on its own line, where everyone on the merge
          request can see them. Only findings you agreed with are sent.
        </p>
      ) : null}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Watched merge requests
// ---------------------------------------------------------------------------

const WATCH_STATE_STYLE: Record<Watch["state"], string> = {
  idle: "border-border bg-muted text-muted-foreground",
  running: "border-primary/40 bg-primary/10 text-primary",
  error: "border-destructive/40 bg-destructive/10 text-destructive",
};

function ago(iso: string | null): string {
  if (iso === null) return "never";
  const seconds = Math.max(0, (Date.now() - Date.parse(iso)) / 1000);
  if (!Number.isFinite(seconds)) return "never";
  if (seconds < 90) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

function WatchRow({
  watch,
  onOpen,
  onOpenThread,
  onRun,
  onRemove,
  onPrompt,
  onEnabled,
}: {
  watch: Watch;
  onOpen: (deckId: string) => void;
  onOpenThread: (threadId: string) => void;
  onRun: () => void;
  onRemove: () => void;
  onPrompt: (prompt: string) => void;
  onEnabled: (enabled: boolean) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [prompt, setPrompt] = useState(watch.prompt);
  const behind =
    watch.headSha !== null &&
    watch.lastSha !== null &&
    watch.headSha !== watch.lastSha;

  return (
    <li className="rounded-lg border border-border bg-card px-3.5 py-3">
      <div className="flex flex-wrap items-center gap-2">
        <span
          className={cn(
            "shrink-0 rounded-full border px-2 py-0.5 text-[11px] leading-none",
            WATCH_STATE_STYLE[watch.state],
          )}
        >
          {watch.state === "running"
            ? "Reviewing…"
            : !watch.enabled
              ? "Paused"
              : watch.state === "error"
                ? "Needs attention"
                : behind
                  ? "New commits"
                  : "Up to date"}
        </span>
        <span className="min-w-0 flex-1 truncate text-sm font-medium text-foreground">
          {watch.title === "" ? watch.url : watch.title}
        </span>
        {watch.draft ? (
          <span className="shrink-0 rounded-full border border-border bg-muted px-2 py-0.5 text-[11px] leading-none text-muted-foreground">
            Draft
          </span>
        ) : null}
      </div>

      <p className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
        <span className="font-mono">
          {watch.projectPath}!{watch.iid}
        </span>
        {watch.mrState === "" ? null : <span>{watch.mrState}</span>}
        {watch.state === "running" ? (
          <>
            <span className="text-primary">
              {watch.deckSlideCount} slide
              {watch.deckSlideCount === 1 ? "" : "s"} so far
              {watch.deckFindingCount === 0
                ? ""
                : `, ${watch.deckFindingCount} finding${watch.deckFindingCount === 1 ? "" : "s"}`}
            </span>
            <span>started {ago(watch.runStartedAt)}</span>
          </>
        ) : (
          <>
            <span>reviewed {ago(watch.lastReviewedAt)}</span>
            <span>checked {ago(watch.lastCheckedAt)}</span>
          </>
        )}
        {watch.bbProjectId === null ? (
          <span className="text-destructive">no matching BB project</span>
        ) : null}
      </p>

      {watch.lastError === null ? null : (
        <p className="mt-1.5 text-[12px] text-destructive">{watch.lastError}</p>
      )}

      <div className="mt-2 flex flex-wrap items-center gap-1.5">
        {watch.deckId === null ? null : (
          <Button
            size="sm"
            variant="outline"
            className="h-7 text-xs"
            onClick={() => onOpen(watch.deckId as string)}
          >
            <Icon name="Code" className="size-3.5" />
            {watch.state === "running" ? "Open deck as it fills" : "Open deck"}
          </Button>
        )}
        {watch.runThreadId === null ? null : (
          <Button
            size="sm"
            variant="ghost"
            className="h-7 px-2 text-xs text-muted-foreground"
            onClick={() => onOpenThread(watch.runThreadId as string)}
          >
            <Icon name="Bot" className="size-3.5" />
            Watch the agent
          </Button>
        )}
        <Button
          size="sm"
          variant="ghost"
          className="h-7 px-2 text-xs text-muted-foreground"
          disabled={watch.state === "running"}
          onClick={onRun}
        >
          <Icon name="Loading" className="size-3.5" />
          Review now
        </Button>
        <Button
          size="sm"
          variant="ghost"
          className="h-7 px-2 text-xs text-muted-foreground"
          onClick={() => setEditing((open) => !open)}
        >
          <Icon name="Edit" className="size-3.5" />
          {watch.prompt.trim() === "" ? "Add a prompt" : "Edit prompt"}
        </Button>
        <Button
          size="sm"
          variant="ghost"
          className="h-7 px-2 text-xs text-muted-foreground"
          onClick={() => onEnabled(!watch.enabled)}
          aria-label={
            watch.enabled
              ? "Pause automatic reviews of this merge request"
              : "Resume automatic reviews of this merge request"
          }
        >
          <Icon name={watch.enabled ? "Circle" : "CircleCheck"} className="size-3.5" />
          {watch.enabled ? "Pause" : "Resume"}
        </Button>
        <UrlLink
          href={watch.url}
          className="ml-auto text-[11px] text-muted-foreground underline-offset-2 hover:underline"
        >
          Open in GitLab
        </UrlLink>
        <Button
          size="sm"
          variant="ghost"
          className="h-7 px-2 text-[11px] text-muted-foreground hover:text-destructive"
          onClick={onRemove}
        >
          <Icon name="Trash2" className="size-3" />
          Stop
        </Button>
      </div>

      {editing ? (
        <div className="mt-2">
          <PromptField
            value={prompt}
            onChange={setPrompt}
            rows={4}
            ariaLabel={`Review prompt for !${watch.iid}`}
            projectId={watch.bbProjectId}
            placeholder="Leave empty to use the default review prompt from settings."
          />
          <div className="mt-1.5 flex gap-1.5">
            <Button
              size="sm"
              className="h-7 text-xs"
              onClick={() => {
                onPrompt(prompt);
                setEditing(false);
              }}
            >
              Save prompt
            </Button>
            <Button
              size="sm"
              variant="ghost"
              className="h-7 text-xs"
              onClick={() => {
                setPrompt(watch.prompt);
                setEditing(false);
              }}
            >
              Cancel
            </Button>
          </div>
        </div>
      ) : null}
    </li>
  );
}

function WatchList({ onOpen }: { onOpen: (deckId: string) => void }) {
  const rpc = useRpc<typeof rpcContract>();
  const watchTheAgent = useWatchTheAgent();
  const [watches, setWatches] = useState<Watch[] | null>(null);
  const [autoReview, setAutoReview] = useState(true);
  const [url, setUrl] = useState("");
  const [prompt, setPrompt] = useState("");
  const [showPrompt, setShowPrompt] = useState(false);
  const [busy, setBusy] = useState(false);

  const refetch = useCallback(() => {
    rpc.call("watches_list").then(
      (result) => {
        setWatches(result.watches as Watch[]);
        setAutoReview(result.autoReview);
      },
      (cause: unknown) => toast.error(String(cause)),
    );
  }, [rpc]);
  useEffect(refetch, [refetch]);
  useRealtime("watches-changed", refetch);
  useRealtime("decks-changed", refetch);

  const add = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const link = url.trim();
    if (link === "" || busy) return;
    setBusy(true);
    rpc
      .call("watch_add", {
        url: link,
        ...(prompt.trim() === "" ? {} : { prompt }),
      })
      .then(
        (result) => {
          if (result.ok) {
            setUrl("");
            toast.success(result.message);
          } else {
            toast.error(result.message);
          }
          refetch();
        },
        (cause: unknown) => toast.error(String(cause)),
      )
      .finally(() => setBusy(false));
  };

  return (
    <section className="mb-6">
      <div className="mb-2 flex items-center justify-between gap-2">
        <h2 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
          Watched merge requests
        </h2>
        {autoReview ? null : (
          <span className="text-[11px] text-muted-foreground">
            Auto re-review is off in settings
          </span>
        )}
      </div>

      <form onSubmit={add} className="space-y-2">
        <div className="flex items-center gap-2">
          <Input
            value={url}
            onChange={(event) => setUrl(event.target.value)}
            placeholder="Paste a merge request link…"
            aria-label="Merge request link"
          />
          <Button type="submit" disabled={busy || url.trim() === ""}>
            <Icon name="Plus" className="size-4" />
            {busy ? "Adding…" : "Watch"}
          </Button>
        </div>
        <button
          type="button"
          onClick={() => setShowPrompt((open) => !open)}
          className="text-[11px] text-muted-foreground underline-offset-2 hover:underline"
        >
          {showPrompt ? "Hide the review prompt" : "Add a review prompt for this one"}
        </button>
        {showPrompt ? (
          <PromptField
            value={prompt}
            onChange={setPrompt}
            rows={3}
            ariaLabel="Review prompt for this merge request"
            placeholder="What to focus on. Leave empty to use the default from settings."
          />
        ) : null}
      </form>

      {watches === null || watches.length === 0 ? (
        <p className="mt-3 rounded-lg border border-dashed border-border px-4 py-4 text-center text-[13px] text-muted-foreground">
          Paste a merge request link above. BB reviews it now and again on every
          push, keeping one deck up to date.
        </p>
      ) : (
        <ul className="mt-3 space-y-2">
          {watches.map((watch) => (
            <WatchRow
              key={watch.id}
              watch={watch}
              onOpen={onOpen}
              onOpenThread={watchTheAgent}
              onRun={() => {
                rpc.call("watch_run_now", { watchId: watch.id }).then(
                  (result) =>
                    result.started
                      ? toast.success(result.message)
                      : toast.error(result.message),
                  (cause: unknown) => toast.error(String(cause)),
                );
              }}
              onRemove={() => {
                rpc
                  .call("watch_remove", { watchId: watch.id })
                  .then(refetch, (cause: unknown) => toast.error(String(cause)));
              }}
              onEnabled={(enabled) => {
                rpc
                  .call("watch_update", { watchId: watch.id, enabled })
                  .then(() => {
                    toast.success(
                      enabled
                        ? "Reviewing again on every push."
                        : "Paused. Press Review now when you want one.",
                    );
                    refetch();
                  }, (cause: unknown) => toast.error(String(cause)));
              }}
              onPrompt={(next) => {
                rpc
                  .call("watch_update", { watchId: watch.id, prompt: next })
                  .then(() => {
                    toast.success("Prompt saved.");
                    refetch();
                  }, (cause: unknown) => toast.error(String(cause)));
              }}
            />
          ))}
        </ul>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------
// The deck list
// ---------------------------------------------------------------------------

function DeckList({ onOpen }: { onOpen: (deckId: string) => void }) {
  const { decks, error, refetch, rpc } = useDecks();

  if (error !== null) {
    return (
      <p role="alert" className="text-sm text-destructive">
        {error}
      </p>
    );
  }
  if (decks === null) return <EmptyState>Loading decks…</EmptyState>;
  if (decks.length === 0) {
    return (
      <EmptyState>
        <p className="font-medium text-foreground">No review decks yet.</p>
        <p className="mx-auto mt-2 max-w-md">
          Ask an agent to review your change and publish a deck. It has the
          <code className="mx-1">review_deck_*</code>
          tools and the <code>review-deck</code> skill that explain how.
        </p>
      </EmptyState>
    );
  }

  return (
    <ul className="space-y-2">
      {decks.map((deck) => (
        <li
          key={deck.id}
          className="group rounded-lg border border-border bg-card transition-colors hover:border-muted-foreground/40"
        >
          <button
            type="button"
            onClick={() => onOpen(deck.id)}
            className="block w-full px-3.5 py-3 text-left"
          >
            <div className="flex items-start gap-2">
              <span className="min-w-0 flex-1 text-sm font-medium text-foreground">
                {deck.title}
              </span>
              {deck.status === "draft" ? (
                <span className="shrink-0 rounded-full border border-border bg-muted px-2 py-0.5 text-[11px] leading-none text-muted-foreground">
                  Draft
                </span>
              ) : null}
              {deck.blockerCount > 0 ? (
                <span className="shrink-0 rounded-full border border-destructive bg-destructive px-2 py-0.5 text-[11px] leading-none text-destructive-foreground">
                  {deck.blockerCount} blocker{deck.blockerCount === 1 ? "" : "s"}
                </span>
              ) : null}
            </div>
            {deck.summary.trim() === "" ? null : (
              <p className="mt-1 line-clamp-2 text-[13px] text-muted-foreground">
                {deck.summary}
              </p>
            )}
            <p className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
              <span>
                {deck.slideCount} slide{deck.slideCount === 1 ? "" : "s"}
              </span>
              <span>
                {deck.annotationCount} finding
                {deck.annotationCount === 1 ? "" : "s"}
              </span>
              <span>
                {deck.approvedCount} of {deck.slideCount} reviewed
              </span>
              {deck.shortstat === "" ? null : (
                <span className="font-mono">{deck.shortstat}</span>
              )}
              <span>{new Date(deck.createdAt).toLocaleString()}</span>
            </p>
          </button>
          <div className="flex justify-end border-t border-border/60 px-2 py-1">
            <Button
              variant="ghost"
              size="sm"
              className="h-6 px-2 text-[11px] text-muted-foreground hover:text-destructive"
              onClick={() => {
                rpc
                  .call("deck_delete", { deckId: deck.id })
                  .then(refetch, (cause: unknown) => toast.error(String(cause)));
              }}
            >
              <Icon name="Trash2" className="size-3" />
              Delete
            </Button>
          </div>
        </li>
      ))}
    </ul>
  );
}

// ---------------------------------------------------------------------------
// The page
// ---------------------------------------------------------------------------

function ReviewPage({ subPath }: { subPath: string }) {
  const navigate = useBbNavigate();
  const [chatOpen, setChatOpen] = useState(false);
  const [deckId, index] = useMemo(() => {
    const parts = subPath.split("/").filter((part) => part !== "");
    const id = parts[0] ?? null;
    const position = Number.parseInt(parts[1] ?? "1", 10);
    return [id, Number.isFinite(position) ? Math.max(0, position - 1) : 0] as const;
  }, [subPath]);

  // Deck on the left, chat on the right. On a narrow screen the chat takes the
  // whole width while it is open rather than squeezing both.
  if (deckId !== null) {
    return (
      <div className="flex h-full min-h-0">
        <div
          className={cn(
            "min-w-0 flex-1 overflow-y-auto",
            chatOpen ? "hidden lg:block" : "",
          )}
        >
          <div className="mx-auto box-border w-full max-w-4xl px-4 pb-8 pt-3 md:px-5 md:pt-4">
            <DeckViewer
              deckId={deckId}
              index={index}
              chatOpen={chatOpen}
              onToggleChat={() => setChatOpen((open) => !open)}
              onIndex={(next) =>
                navigate.toPluginPanel(PANEL_PATH, {
                  subPath: `${deckId}/${next + 1}`,
                  replace: true,
                })
              }
              onClose={() => navigate.toPluginPanel(PANEL_PATH, { subPath: "" })}
            />
          </div>
        </div>
        {chatOpen ? (
          <DeckChat
            deckId={deckId}
            onClose={() => setChatOpen(false)}
            className="w-full lg:w-[26rem] lg:shrink-0 lg:border-l"
          />
        ) : null}
      </div>
    );
  }

  return (
    <div className="h-full min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto box-border w-full max-w-4xl px-4 pb-8 pt-3 md:px-5 md:pt-4">
        {deckId === null ? (
          <>
            <p className="mb-4 text-sm text-muted-foreground">
              Guided walk-throughs of a change, one slide per group of related
              edits, with the agent's findings pinned to the exact lines.
            </p>
            <WatchList
              onOpen={(id) =>
                navigate.toPluginPanel(PANEL_PATH, { subPath: `${id}/1` })
              }
            />
            <h2 className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
              All decks
            </h2>
            <DeckList
              onOpen={(id) =>
                navigate.toPluginPanel(PANEL_PATH, { subPath: `${id}/1` })
              }
            />
          </>
        ) : null}
      </div>
    </div>
  );
}

/** The same viewer inside a thread's side panel, plus a way to start one. */
function ThreadDeckPanel({ threadId }: { threadId: string }) {
  const rpc = useRpc<typeof rpcContract>();
  const navigate = useBbNavigate();
  const watchTheAgent = useWatchTheAgent();
  const [status, setStatus] = useState<{
    running: boolean;
    runThreadId: string | null;
    deckId: string | null;
    slideCount: number;
    isRunner: boolean;
    reviewing: string | null;
    canStartReview: boolean;
    attachedAs: string | null;
    attachedDeckTitle: string | null;
  } | null>(null);
  const [index, setIndex] = useState(0);
  const [prompt, setPrompt] = useState("");
  const [showPrompt, setShowPrompt] = useState(false);
  const [busy, setBusy] = useState(false);

  const refetch = useCallback(() => {
    rpc.call("thread_review_status", { threadId }).then(setStatus, () =>
      setStatus({
        running: false,
        runThreadId: null,
        deckId: null,
        slideCount: 0,
        isRunner: false,
        reviewing: null,
        canStartReview: true,
        attachedAs: null,
        attachedDeckTitle: null,
      }),
    );
  }, [rpc, threadId]);
  useEffect(refetch, [refetch]);
  useRealtime("decks-changed", refetch);
  // A review starting or ending only moves the watch, so listen to both.
  useRealtime("watches-changed", refetch);

  const start = () => {
    if (busy) return;
    setBusy(true);
    rpc
      .call("thread_review_start", {
        threadId,
        ...(prompt.trim() === "" ? {} : { prompt }),
      })
      .then(
        (result) => {
          result.started
            ? toast.success(result.message)
            : toast.error(result.message);
          refetch();
        },
        (cause: unknown) => toast.error(String(cause)),
      )
      .finally(() => setBusy(false));
  };

  if (status === null) return <EmptyState>Looking for a deck…</EmptyState>;

  // Inside the thread doing the review: show the deck as it is written, so you
  // can read the agent's reasoning on one side and its output on the other.
  if (status.isRunner) {
    return (
      <div className="space-y-3">
        <div className="rounded-lg border border-border bg-card px-3 py-2">
          <p className="text-[13px] text-foreground">
            {status.running
              ? "This thread is writing the deck below."
              : "This thread wrote the deck below."}
          </p>
          {status.reviewing === null ? null : (
            <p className="mt-0.5 truncate text-[11px] text-muted-foreground">
              Reviewing {status.reviewing}
            </p>
          )}
          {status.deckId === null ? null : (
            <Button
              variant="ghost"
              size="sm"
              className="mt-1 h-7 px-2 text-xs text-muted-foreground"
              onClick={() =>
                navigate.toPluginPanel(PANEL_PATH, {
                  subPath: `${status.deckId}/${index + 1}`,
                })
              }
            >
              <Icon name="Workflow" className="size-3.5" />
              Open full page
            </Button>
          )}
        </div>
        {status.deckId === null ? (
          <EmptyState>
            {status.running
              ? "Reading the code. Slides appear here as the agent writes them."
              : "This review finished without writing any slides."}
          </EmptyState>
        ) : (
          <DeckViewer
            deckId={status.deckId}
            index={index}
            onIndex={setIndex}
            compact
          />
        )}
      </div>
    );
  }

  const attachRow =
    status.attachedAs !== null ? (
      <div className="rounded-lg border border-border bg-card px-3 py-2">
        <p className="text-[13px] text-foreground">
          {status.attachedAs === "fix"
            ? "You are fixing findings from this deck."
            : "This deck is attached to this thread."}
        </p>
        <p className="mt-0.5 truncate text-[11px] text-muted-foreground">
          {status.attachedDeckTitle}
        </p>
        <Button
          variant="ghost"
          size="sm"
          className="mt-1 h-7 px-2 text-xs text-muted-foreground"
          onClick={() => {
            rpc
              .call("deck_detach", { threadId })
              .then(refetch, (cause: unknown) => toast.error(String(cause)));
          }}
        >
          <Icon name="X" className="size-3.5" />
          Detach
        </Button>
      </div>
    ) : (
      <AttachDeck threadId={threadId} onAttached={refetch} />
    );

  const starter = (
    <div className="rounded-lg border border-border bg-card px-3 py-3">
      <p className="text-[13px] text-foreground">
        {status.deckId === null
          ? "Turn this thread's changes into a review deck."
          : "Review the current changes again and rewrite the deck."}
      </p>
      <p className="mt-1 text-[11px] text-muted-foreground">
        A second agent reviews this thread's workspace, including work that is
        not committed yet. It reads only — it will not edit your files.
      </p>
      <div className="mt-2 flex flex-wrap items-center gap-1.5">
        <Button
          size="sm"
          className="h-7 text-xs"
          disabled={busy || status.running}
          onClick={start}
        >
          <Icon name="Bot" className="size-3.5" />
          {status.running
            ? `Reviewing… ${status.slideCount} slide${status.slideCount === 1 ? "" : "s"}`
            : status.deckId === null
              ? "Review these changes"
              : "Review again"}
        </Button>
        <Button
          size="sm"
          variant="ghost"
          className="h-7 px-2 text-xs text-muted-foreground"
          onClick={() => setShowPrompt((open) => !open)}
        >
          <Icon name="Edit" className="size-3.5" />
          {showPrompt ? "Hide prompt" : "Add a prompt"}
        </Button>
        {status.runThreadId === null ? null : (
          <Button
            size="sm"
            variant="ghost"
            className="h-7 px-2 text-xs text-muted-foreground"
            onClick={() => watchTheAgent(status.runThreadId as string)}
          >
            <Icon name="Bot" className="size-3.5" />
            Watch the agent
          </Button>
        )}
      </div>
      {showPrompt ? (
        <PromptField
          value={prompt}
          onChange={setPrompt}
          rows={3}
          className="mt-2"
          ariaLabel="Review prompt for this thread"
          placeholder="What to focus on. Leave empty to use the default from settings."
        />
      ) : null}
    </div>
  );

  if (status.deckId === null) {
    return (
      <div className="space-y-3">
        {starter}
        {attachRow}
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {status.attachedAs === null ? starter : null}
      {attachRow}
      <Button
        variant="ghost"
        size="sm"
        className="h-7 px-2 text-xs text-muted-foreground"
        onClick={() =>
          navigate.toPluginPanel(PANEL_PATH, {
            subPath: `${status.deckId}/${index + 1}`,
          })
        }
      >
        <Icon name="Workflow" className="size-3.5" />
        Open full page
      </Button>
      <DeckViewer deckId={status.deckId} index={index} onIndex={setIndex} compact />
    </div>
  );
}

export default definePluginApp((app) => {
  app.slots.navPanel({
    id: "review",
    title: "Review Deck",
    icon: "Code",
    path: PANEL_PATH,
    component: ReviewPage,
  });

  app.slots.threadPanelAction({
    id: "thread-deck",
    title: "Review deck",
    component: ThreadDeckPanel,
    run: ({ openPanel }) => {
      openPanel({ title: "Review deck" });
    },
  });

  // Only offered where it can land: the palette opens anywhere, but the panel
  // needs a thread. The sidebar page covers everywhere else.
  app.slots.commandPaletteAction({
    id: "open-review-decks",
    title: "Review Deck: open this thread's review deck",
    isAvailable: ({ threadId }) => threadId !== null,
    run: ({ openPanel }) => {
      openPanel({ actionId: "thread-deck", title: "Review deck" });
    },
  });
});
