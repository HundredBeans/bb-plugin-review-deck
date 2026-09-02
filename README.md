# Review Deck

Guided code review in BB. An agent reviews a change and publishes it as a
**slide deck**; you click through it with the arrow keys, one group of related
changes per slide, with the agent's findings sitting on the exact lines they
talk about.

## Installing

```sh
bb plugin install git:<your-repo-url>@^0.1.0     # tracks 0.x releases
bb plugin install <your-repo-url>                # tracks the default branch
bb plugin install ./bb-plugin-review-deck        # a local checkout
```

BB runs `npm install --omit=dev` and builds the plugin itself, so nobody needs
to build anything by hand. It needs `glab` installed and authenticated on the
machine running the BB server — see "Watching a merge request" below.

## What a slide holds

- A **title** and a short **plain-language summary** — what this group of
  changes does, not a list of file names.
- The **files** that belong together. Only the paths are stored: BB reads the
  real diff from your workspace at view time, so a deck cannot drift from the
  code.
- **Findings pinned to a line**, shown between the lines of the diff. Each one
  has a severity, what happens, the impact, and whether the fix belongs in this
  change. A finding can carry a concrete replacement snippet.
- An optional **diagram** — a flow of how parts connect, or a sequence of who
  calls whom in what order. Drawn as plain SVG in your BB theme, no charting
  library in the bundle.

## Reviewing

Open **Review Deck** in the sidebar, or the **Review deck** tab in a thread's
side panel to read it beside the agent that wrote it.

- `←` and `→` move between slides. The dots show where you are and which
  slides you have already marked.
- Every finding has **Agree** / **Disagree** and a reply box.
- Each slide gets **Looks good** or **Needs work** plus a free note.
- **Copy notes** puts your replies on the clipboard as markdown. **Send to
  agent** posts them straight into the thread that built the deck.
- **Plain diff** switches a file to BB's own diff viewer with syntax
  highlighting, when you want to read the code without the notes on top.

## Chatting about a deck

Press **Chat** in the deck header and BB's real chat opens beside the slides —
same composer, same skills, same permission handling, because it is the actual
thread surface rather than a copy of it. On a narrow screen the chat takes the
whole width while it is open.

Opening the chat is **not** a statement that you have finished. The agent is
given the deck — its slides and what the change does — and told plainly that
you are still reading: answer questions, do not summarise, do not suggest next
steps, do not touch any files. It works in the right workspace, so it can read
the code to answer you.

The conversation belongs to the deck, so closing and reopening comes back to it
rather than starting again. When you do finish, **Send my notes to the chat**
at the end of the deck hands over what you decided, in the same conversation.

**You can ask it to change the deck.** "Drop that finding", "that is a nit not
a blocker", "the line number is wrong", "add a slide about the migration" — the
agent edits the deck you are looking at and it updates in front of you. A
finding it rewords keeps your Agree or Disagree; a finding it removes takes
your answer with it. It is told never to build a new deck for a change you
asked for.

Each slide has **Ask about this**, which drops that slide into the chat — its
summary, its files, and each finding with whether you agreed, disagreed, or
have not answered — so a question does not start from nothing.

## When you reach the end

The last slide is followed by **What now?** — a deck is only worth having if
something happens next. Everything there works from the findings you marked
**Agree** on.

| Action | What it does |
| --- | --- |
| **Talk it through with an agent** | Hands your notes to the deck's chat. The agent says what it thinks the real work is, offers next steps, and waits. If a chat is already open the button reads **Send my notes to the chat** and continues it. |
| **Fix the N agreed findings** | Opens a thread that works through them in order, in the right workspace. For a merge request that is a fresh worktree with the branch already fetched. |
| **Post to !N as inline comments** | Writes each agreed finding onto the merge request, anchored to its own line. Asks for confirmation first. |
| **Reply in the original thread** | For a deck an agent wrote in one of your conversations, or a thread review — sends your notes back to the thread that already has the context. |
| **Copy notes** | The whole thing as markdown. |

Only findings you agreed with are ever sent anywhere. Ones you rejected, and
ones you have not answered, stay in the deck.

**A note on posting.** Comments go out as GitLab `DiffNote`s with a full
position (`base_sha`, `start_sha`, `head_sha`, path, line). Sending the
position as form fields instead of a JSON body silently drops it and the
comment lands unanchored at the bottom of the merge request, so the plugin
posts JSON on stdin and checks each reply really came back as a `DiffNote`.
Anything that did not anchor is reported rather than counted as posted.

From a shell: `bb review-deck post <deck-id>`.

## Watching a merge request

Paste a GitLab merge request link into **Watched merge requests** at the top of
the Review Deck page. BB reviews it straight away, then re-reviews it on every
push — you never have to ask.

Optionally give that merge request its own prompt ("focus on the migration",
"check the retry logic"). Leave it empty and it uses the default prompt from
the plugin settings.

Every prompt box in the plugin completes skills: type `/` and pick from your
real skill list, so a watch can just say `/code-review` and get the review you
already wrote. Arrow keys move, Enter or Tab inserts, Escape closes. A `/` in
the middle of a word does not open the menu, so file paths are left alone.

Each watch keeps **one deck**, and its link never changes. When the branch is
pushed to, the deck is rewritten in place and your marks come with it:

- A finding that is still there keeps your Agree / Disagree and your reply.
- A finding that is gone takes its mark with it.
- A new finding arrives unmarked, so what you see is what changed.

Marks are matched on file plus finding title, so a reworded finding comes back
unmarked. That is the safer way to be wrong.

Reviews run in a throwaway worktree cut from the project's default branch; the
agent fetches the merge request into it, so your own checkout is never touched.
The worker thread is hidden and is archived and stopped when the review ends.
Nothing is ever posted back to GitLab.

**Stopping a review is safe.** Stop the review thread whenever you like. The
merge request is not recorded as reviewed, the deck you already had is put
back, and the watch says why. Only a review that runs to the end counts.

**One automatic attempt per commit.** A commit whose review was stopped or
failed is not tried again by the sweep — otherwise a review you keep stopping
becomes an agent run every few minutes for as long as that commit is at the
head. **Review now** always runs, and it clears the block.

After three failed runs in a row a watch **pauses itself** and says so. Press
**Review now** or **Resume** when you are ready. You can also press **Pause**
at any time; a paused watch never starts on its own.

**What it needs**

- `glab`, installed and authenticated on the BB server (`glab auth login`).
  The plugin shells out to `glab api`, so it reuses the login you already have
  and needs no token of its own.
- The merge request's repository must already be a BB project — the watcher
  matches on the project's git remote. SSH and HTTPS remotes compare equal.

GitHub is not supported yet. The GitLab-specific parts are confined to
`lib/gitlab.ts` and the `glabApi` helper in `server.ts`.

## Reviewing a thread's own changes

You do not need a merge request. Open any thread's right panel, pick
**Review deck**, and press **Review these changes**.

A second agent reviews that thread's workspace — including work that is not
committed yet — and publishes a deck. A separate reviewer is deliberate: an
agent asked to find fault with its own work tends to agree with itself. The
reviewer reads only; it does not edit your files.

The deck is attached to the thread it reviewed, so the same panel shows it
afterwards. Press **Review again** after more work and the deck is rewritten in
place, keeping your marks, exactly like a watched merge request.

From a shell, inside the thread: `bb review-deck review-thread [--prompt "..."]`.

The reviewer shares the thread's workspace rather than getting its own, so it
is only stopped when it finishes — never archived, because archiving the last
thread of a managed worktree destroys the worktree.

## Seeing what a review is doing

- The watch row shows `N slides so far, M findings · started Xm ago` while a
  review runs, and the thread panel shows the same on its button.
- **Open deck as it fills** — a deck updates live as slides land, with a banner
  saying it is still being written.
- **Watch the agent** opens the thread doing the review **with the deck beside
  it**, so you read the agent's reasoning on one side and the slides appearing
  on the other. The panel recognises a reviewer from the run itself, not from
  its output, so it says "Reading the code" during the first minutes when no
  slides exist yet instead of offering to start another review.

Review threads are hidden from the sidebar by default. Turn off **"Keep review
threads out of the sidebar"** in settings to have them appear as normal threads.

## Which project a review runs in

A merge-request review runs in the BB project whose git remote matches, because
the throwaway worktree is cut from **that project's own source**. A thread in
project B cannot get a worktree of project A's repository, so a review cannot
simply be filed somewhere else.

What you can do is give the repository a second project — a "Code reviews"
project with the same remote — and set **"Prefer this project for merge request
reviews"**. Reviews then run there and stay out of your working project. The
preference is only honoured when that project really has the repository;
otherwise the project that does is used, because a worktree of the wrong
repository is worse than a review in the wrong place.

Reviews of a thread's own changes cannot move: they share that thread's
workspace, so they belong to its project by definition.

If the goal is only to stop review threads cluttering the sidebar, the
**"Keep review threads out of the sidebar"** setting does that on its own.

## How an agent builds one

The plugin ships a `review-deck` skill, so an agent in BB already knows the
procedure. It has these tools:

| Tool | What it does |
| --- | --- |
| `review_deck_changed_files` | The changed files with line counts, so the agent can plan the slides. |
| `review_deck_read` | A deck as it stands, with slide and finding ids. |
| `review_deck_edit` | Change a deck in place: slides, findings, order, severities. |
| `review_deck_create` | Starts a deck; returns a `deckId`. |
| `review_deck_add_slide` | Adds one slide: summary, files, annotations, suggestions, diagram. |
| `review_deck_finish` | Marks the deck ready and returns the link. |

Just ask: *"review this branch and publish a review deck"*.

## CLI

`bb review-deck` does the same job for scripts and for agents without native
tools:

```sh
bb review-deck files                          # changed files in this thread's workspace
bb review-deck create --file deck.json        # build a whole deck in one go
bb review-deck list
bb review-deck show <deck-id>
bb review-deck notes <deck-id>                # the reviewer's replies, as markdown
bb review-deck delete <deck-id>

bb review-deck watch <mr-url> [--prompt "..."]   # watch and review now
bb review-deck watches                           # watched merge requests
bb review-deck review <watch-id>                 # review now, even if nothing changed
bb review-deck unwatch <watch-id>
bb review-deck poll                              # check every watch right now
bb review-deck post <deck-id>                    # agreed findings -> inline MR comments

bb review-deck review-thread [--prompt "..."]    # review this thread's changes
```

`examples/sample-deck.json` is a complete deck file — a four-slide review with
both diagram kinds, three severities and an inline patch. Try it with:

```sh
bb review-deck create --file examples/sample-deck.json
```

## Settings

| Setting | Default | Effect |
| --- | --- | --- |
| Which diff a new deck reviews | branch and uncommitted | `branch only` compares against the merge base; `uncommitted only` reviews the working tree. |
| Decks to keep per project | 20 | Older decks are deleted when a new one is created. Watched merge requests are never pruned. |
| Minutes between checks | 5 | How often watched merge requests are checked for new commits. |
| Re-review on new commits | on | Turn off for all watches at once. **Pause** does the same for one watch. |
| Also review drafts | off | Draft merge requests are skipped unless you press **Review now**. |
| Default review prompt | see settings | Used by any watch or thread review with no prompt of its own. |
| Keep review threads out of the sidebar | on | Turn off to watch reviews as ordinary threads. |
| Prefer this project for reviews | unset | Run merge request reviews in a chosen project, when it has the same repository. |

Reload the plugin after changing a setting: `bb plugin reload review-deck`.

## Developing

```sh
npm install
bb plugin install .     # register this directory in place
bb plugin dev           # rebuild and reload on every save
npm run typecheck
npm test                # re-review keeps the reviewer's marks
```

`npm test` drives the plugin against the SDK's fake host and covers the things
that were easiest to get wrong — every one of these is a bug that actually
happened:

- an older database gets its missing columns back on load;
- after a re-review a surviving finding keeps its mark, a fixed one loses it, a
  new one arrives unmarked, and the deck link does not change;
- two review requests at once spawn one agent, not two;
- a deck still shows its code after its worktree has been retired;
- a re-review that dies half way through restores the deck you already had;
- a stopped review is not recorded as reviewed, and is not retried on every
  sweep for ever.

The suite is offline. Merge-request lookups go through
`tests/fixtures/fake-glab.mjs` instead of real `glab`, selected with the
`BB_REVIEW_DECK_GLAB` environment variable — which also lets anyone whose
`glab` is not on `PATH` point the plugin at it.

**Schema note.** This plugin does not use `bb.storage.migrate`. Its statements
are keyed by position, so inserting one in the middle silently shifts every
later statement — which is how a column went missing on a live database here.
Schema setup is plain idempotent DDL plus an `ensureColumn` helper, safe to run
on every load in any order.

Layout:

| Path | What it is |
| --- | --- |
| `server.ts` | Storage, RPC, the four agent tools, the CLI command. |
| `lib/deck-schema.ts` | The zod schemas and types both sides share. |
| `lib/gitlab.ts` | Merge-request links, git remotes, and the keys that carry marks across a re-review. |
| `lib/patch.ts` | A small unified-patch reader; feeds the annotated view. |
| `components/annotated-diff.tsx` | The diff with findings between the lines. |
| `components/diagram.tsx` | Flow and sequence diagrams, drawn as SVG. |
| `components/prompt-field.tsx` | Prompt box with the `/` skill menu. |
| `app.tsx` `DeckChat` | BB's `ThreadChat` embedded beside the deck. |
| `components/slide-view.tsx` | One slide. |
| `app.tsx` | The sidebar page, the thread panel, the palette action. |
| `skills/review-deck/SKILL.md` | How an agent builds a deck. |
| `tests/re-review.mts` | Marks survive a re-review; concurrent runs spawn one agent. |
| `tests/snapshot.mts` | A deck keeps its code after the worktree is retired. |
| `tests/schema.mts` | An older database is repaired on load. |
| `tests/interrupted.mts` | A failed re-review restores the previous deck. |
| `tests/stopped.mts` | A stopped review is not recorded as reviewed. |
| `tests/no-retry-loop.mts` | A failed review is not retried every sweep. |
| `tests/gitlab-position.mts` | Inline comment positions are well formed. |
| `tests/slash-menu.mts` | The `/` menu opens on skills, not on file paths. |
| `tests/chat-intent.mts` | The chat opens as a question, not as a verdict. |
| `tests/runner-panel.mts` | A reviewer thread shows its review, deck or not. |
| `tests/deck-edit.mts` | A deck edits in place without losing your answers. |

## License

MIT — see [LICENSE](LICENSE).
