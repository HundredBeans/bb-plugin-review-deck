---
name: review-deck
description: Publish a code review as a guided slide deck the human can click through, with findings pinned to exact lines and optional diagrams. Use after reviewing a branch, a pull request, or the working tree — whenever the user asks for a code review, a walk-through of a change, or says "review this", "explain these changes", or "make a review deck".
---

# Review deck

A review deck turns your review into slides. Each slide covers one group of
related changes: a short summary, the files, your findings pinned to the exact
lines, and an optional diagram. The human clicks through it with the arrow
keys, marks each slide, and can send their replies back to you.

Publish a deck instead of writing one long chat message. A long message scrolls
away; a deck stays, and the reviewer answers you inside it.

## When to build one

Build a deck when the user asks you to review code, walk them through a change,
or explain a diff. Do not build one for a one-file typo fix — say what you
found in chat instead.

## Steps

1. **Read the change.** Call `review_deck_changed_files` first. It returns the
   changed files with added and removed line counts. Read the code itself with
   your normal file tools before you judge it.

2. **Group the files into slides.** Group by concern, not by folder. One slide
   is one thing the reviewer must understand at a time. Aim for 3–8 slides. A
   slide the reviewer cannot read in a minute is two slides.

   A good shape:
   - slide 1, `kind: "overview"` — what the whole change does and how the parts
     fit together. Put a diagram here.
   - middle slides, `kind: "change"` — one per concern, in the order that makes
     the change easy to follow. Put the entry point first, not the helpers.
   - `kind: "risk"` for anything that can break in production.
   - `kind: "test"` for the test coverage, and what is still untested.
   - last slide, `kind: "wrapup"` — what you would change before merging.

3. **Create the deck**: `review_deck_create` with a `title` and a `summary` of
   two to four sentences. It returns a `deckId`.

   If you are reviewing a merge request, pass its URL as `mergeRequestUrl`.
   BB then keeps this deck up to date on every later push, without re-reviewing
   the commit you just looked at. Leave it out and nothing will ever update the
   deck, because BB has no way to know which merge request it was about.

4. **Add each slide**: `review_deck_add_slide`, once per slide, in the order the
   reviewer should see them.

5. **Finish**: `review_deck_finish` with the `deckId`. It returns the link and a
   sentence to tell the user. Tell them the deck is ready and where it is.

## Publishing a review you have already done

If you have just reviewed something in this conversation and are then asked for
a deck, **do not review it again**. You already have the findings; this is only
about putting them into slides.

- Skip `review_deck_changed_files` — you know what changed.
- Do not re-read the diff. Go straight to `review_deck_create`, then one
  `review_deck_add_slide` per group, then `review_deck_finish`.
- Reuse the wording you already gave the user. They have read it once; changing
  it makes them re-read everything.
- Only open a file again if you are unsure of a line number for one finding.
  Check that file, not the whole change.

Re-reviewing here costs minutes and produces a second opinion nobody asked
for. If you genuinely have not reviewed anything yet, say so rather than
inventing a deck from the conversation.

## Writing a slide

- `summary` — two or three sentences of plain language. What this group of
  changes does. Not a list of file names; the files are already shown.
- `why` — one line, only when the reviewer would otherwise miss the point.
- `files` — pass the `path` only. BB reads the real diff from the workspace, so
  never paste the diff yourself. Use `patch` only for code that is not in the
  workspace diff at all. `role` is one short line saying why this file is here.

## Writing a finding

Findings go in `annotations`, pinned to a line. `line` is the line number on
the side of the diff you name — `side: "new"` for the code after the change
(use this almost always), `side: "old"` for a line that was deleted. Use
`endLine` when the finding covers a block.

Write every `body` in three parts, in this order:

1. **What happens** — the mechanism, step by step. Not "this is wrong", but
   what the code actually does.
2. **Impact** — what goes wrong, and for whom: the caller, the user, the
   database, CI. If nothing visible goes wrong yet, say that plainly.
3. **Scope** — does the fix belong in this change, or somewhere else? Say
   which. If part of it belongs here and part does not, split it.

Rules for the words themselves:

- Short sentences. Plain words. No jargon and no idioms.
- Never leave the reviewer to work out why a finding matters.
- Put a concrete replacement in `suggestion` when you have one. Code only, no
  prose — the reviewer sees it as a code block.

Pick the `severity` honestly:

| Severity | Use it for |
| --- | --- |
| `blocker` | Merging this ships a bug, a data loss, or a security hole. |
| `issue` | A real problem worth fixing, but not merge-stopping. |
| `question` | You do not know if it is wrong; you need the author to answer. |
| `nit` | Style or naming. The author may ignore it. |
| `praise` | Something done well and worth keeping. Use it sparingly. |
| `info` | Context the reviewer needs, not a problem. |

Do not inflate severity. A deck full of blockers is a deck nobody reads.

Use `suggestions` for a point about the whole slide that has no single line —
"this module has no tests", say.

## Diagrams

A diagram is optional but it is what makes a change click. Add one to the
overview slide and to any slide about control flow. Two kinds:

**`flow`** — how parts connect. Nodes and edges, laid out in layers.

```json
{
  "kind": "flow",
  "title": "Payout retry path",
  "direction": "down",
  "nodes": [
    { "id": "api", "label": "POST /payouts", "note": "routes/payouts.ts" },
    { "id": "queue", "label": "Retry queue", "tone": "added" },
    { "id": "worker", "label": "Payout worker", "tone": "changed" },
    { "id": "psp", "label": "Provider API", "tone": "external" }
  ],
  "edges": [
    { "from": "api", "to": "queue", "label": "enqueue" },
    { "from": "queue", "to": "worker" },
    { "from": "worker", "to": "psp", "label": "charge", "style": "dashed" }
  ]
}
```

Set `tone` to show what the change did to each part: `added` for new,
`changed` for edited, `removed` for deleted, `external` for something outside
this codebase, `default` for untouched.

**`sequence`** — the order of calls over time. Use it when the bug or the
change is about ordering, retries, or who calls whom first.

```json
{
  "kind": "sequence",
  "title": "Retry after a timeout",
  "actors": [
    { "id": "worker", "label": "Worker" },
    { "id": "psp", "label": "Provider" },
    { "id": "db", "label": "payouts table" }
  ],
  "steps": [
    { "from": "worker", "to": "psp", "label": "charge(idempotencyKey)" },
    { "from": "psp", "to": "worker", "label": "timeout", "style": "return" },
    { "from": "worker", "to": "db", "label": "mark retrying", "changed": true },
    { "from": "worker", "to": "worker", "label": "back off 30s", "changed": true }
  ]
}
```

Set `changed: true` on the steps this change added or altered, so the reviewer
sees the new behaviour at a glance.

Keep a diagram under about 12 nodes or steps. A diagram that needs more than
that belongs on two slides.

## Re-reviewing

A watched merge request keeps one deck, and so does a reviewed thread. A
re-review rewrites that deck rather than making a new one. The
reviewer's Agree / Disagree marks are carried onto the new findings by
**file path plus finding title**.

So when a finding is still true after a push, give it the **same title you gave
it last time**. Reword it and the reviewer loses their answer and has to judge
it again. Change the title only when the finding itself has changed.

Drop a finding that the push fixed — do not keep it with a "fixed" note. Its
mark disappears with it, which is what the reviewer wants.

## Changing a deck that already exists

When the reviewer asks you to change something about a deck — "drop that
finding", "that is a nit not a blocker", "the line number is wrong", "split
this slide" — **edit the deck, do not build a new one**. They are looking at
it; an edit shows up in front of them.

1. `review_deck_read` — the deck with every slide's `slideId` and position and
   every finding's `findingId`. Inside a deck's own chat you can omit `deckId`.
2. `review_deck_edit` with a list of `operations`, applied in order:

| Operation | For |
| --- | --- |
| `set_deck` | The deck's title or summary. |
| `add_slide` | A new slide, optionally `after` an existing one. |
| `edit_slide` | Reword a slide, change its kind, its files, its diagram. |
| `remove_slide` | Drop a slide and its findings. |
| `move_slide` | Reorder. |
| `add_finding` | A finding on a slide. |
| `edit_finding` | Severity, wording, line, path, suggestion. |
| `remove_finding` | Drop a finding. |

A slide is named by its `slideId` or by the position the reviewer sees — not by
its title. A finding is named by its `findingId`. Every operation reports what
it did, or says "no slide 4" so you can correct yourself.

**What this does to the reviewer's answers.** A finding you edit keeps its id,
so their Agree or Disagree stays on it — which is right for a reworded finding
and wrong if you reuse one finding's slot for an unrelated point. Remove and
add instead when it is genuinely a different finding. A finding you remove
takes their answer with it.

`review_deck_create` still means "review this again from scratch". Reach for it
only for a fresh review, never for a change the reviewer asked for.

## Reading the reviewer's answer

The reviewer marks each slide "Looks good" or "Needs work", replies to
individual findings, and can send it all back to your thread. When that arrives:

- Fix what they agreed with.
- Where they disagreed, take their reason seriously and re-check the code
  before you argue. If they are right, say so plainly and move on.

Run `bb review-deck notes <deck-id>` at any time to read the current replies.

## The CLI

The `review_deck_*` tools are the normal path. `bb review-deck` does the same
job for scripts and for agents without native tools:

| Command | Effect |
| --- | --- |
| `bb review-deck files` | The changed files in this thread's workspace. |
| `bb review-deck create --file deck.json` | Build a whole deck from one JSON file. |
| `bb review-deck list` | List decks with their ids. |
| `bb review-deck show <deck-id>` | The slides in a deck. |
| `bb review-deck notes <deck-id>` | The reviewer's replies, as markdown. |
| `bb review-deck delete <deck-id>` | Delete a deck. |
| `bb review-deck review-thread` | Review the current thread's own changes. |

`deck.json` is `{ "title": ..., "summary": ..., "slides": [ ... ] }` where each
slide takes the same fields as `review_deck_add_slide`.

## Rules

- Never paste a diff into `patch` when the file is in the workspace diff. BB
  reads the real diff, so the deck cannot drift from the code.
- Check the line numbers you pin to. A finding on the wrong line wastes the
  reviewer's time more than no finding at all.
- One deck per review. If you review again after changes, make a new deck.
