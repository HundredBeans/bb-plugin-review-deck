# Changelog

Notable changes to Review Deck. Follows [Keep a Changelog][kac]; versions are
[semantic][semver], with 0.x minor bumps carrying features and visible changes.

[kac]: https://keepachangelog.com/en/1.1.0/
[semver]: https://semver.org/spec/v2.0.0.html

## [Unreleased]

### Changed

- **A merged or closed merge request no longer polls.** Linking one still works
  — that is what makes posting findings to it possible — but it is created
  paused, because nothing will ever push to it again. A watch whose merge
  request settles pauses itself on the next sweep instead of checking it every
  few minutes for ever.

## [0.3.0] — 2026-09-07

### Added

- **Keep an existing deck up to date.** A deck published from a conversation
  had no merge request recorded, so nothing ever updated it — no watch, no
  re-review on push. Such a deck now says so and offers **Keep it up to date**;
  paste the link and it becomes a watch. The current commit counts as already
  reviewed, because the deck is that review, so linking starts nothing and only
  the next push triggers a re-review, into the same deck. Agents can do it as
  they publish by passing `mergeRequestUrl` to `review_deck_create`. Also
  `bb review-deck watch-deck <deck-id> <mr-url>`. Linking a merge request that
  another deck already watches is refused rather than silently taken over.
- A changelog.

### Fixed

- **Removing a watch left its deck claiming to be watched.** `decks.watch_id`
  was not cleared, so the deck reported itself as kept current while nothing
  was watching it. Existing rows are repaired on load.

## [0.2.0] — 2026-09-07

### Added

- **Attach a deck to a thread that did not create it.** A deck used to belong
  only to the thread that made it, so the thread opened by **Fix the N agreed
  findings** showed no deck — its panel offered to review the fix thread
  instead of showing the findings being fixed. A fix run now links the deck
  automatically, and any thread can attach one by hand from its **Review deck**
  panel and detach it again. An attached deck is also what an agent in that
  thread means by "this deck", so `review_deck_read` and `review_deck_edit`
  work there with no id. Linking does not copy: one deck and one set of your
  answers however many threads point at it.
- **Publish a review a thread has already done.** If an agent has just reviewed
  something in a conversation and only then do you want a deck, **Publish the
  review already in this thread** asks that agent to put what it found into
  slides — no second agent and no re-reading the diff. The skill tells it to
  skip `review_deck_changed_files`, reuse the wording you have already read,
  and refuse to invent a deck if no review actually happened.
- An MIT licence.

### Fixed

- **Talking about a deck opened a new thread when the deck's own conversation
  was right there.** The chat action only consulted the deck's dedicated chat
  thread, so a deck written in an ordinary conversation — or attached to one —
  spawned a fresh agent that had to be told everything. A chat now resolves to
  the deck's chat, then the thread that wrote it, then the thread it reviewed,
  then one it is attached to, and opens a new thread only when none of those is
  usable. Whichever it lands in becomes the deck's chat, so the panel and the
  next press agree, and the button names the thread it will post to.

### Removed

- The **Reply in the original thread** action, which was a second button doing
  the same job as the chat action by a different route.

## [0.1.0] — 2026-09-02

First release.

### Added

- **Guided slide decks.** One slide per group of related changes, each with a
  plain-language summary, the files that belong together, and findings pinned
  to exact lines of the diff. Arrow keys move between slides.
- **Findings on the code.** A custom diff renderer puts each finding between
  the lines it talks about, with a severity ladder of `blocker`, `issue`,
  `question`, `nit`, `praise`, `info`. **Agree** / **Disagree** and a reply per
  finding; **Looks good** / **Needs work** and a note per slide.
- **Diagrams**, drawn as plain SVG in the BB theme rather than by bundling a
  charting library: `flow` for how parts connect, `sequence` for call order,
  with tones marking what the change added, altered or removed.
- **Watched GitLab merge requests.** Paste a link and it is reviewed at once,
  then again on every push, into the same deck with a stable URL. Your marks
  carry forward: a surviving finding keeps its answer, a fixed one loses it, a
  new one arrives unmarked. Reviews run in a throwaway worktree, and a deck
  keeps a copy of its diff so it still shows code after that worktree is gone.
- **Reviewing a thread's own changes**, including uncommitted work, by a second
  agent so the review is not the author marking its own homework.
- **A chat beside the deck**, using BB's own thread surface. Opening it is not
  a claim that you have finished; the agent answers questions and can edit the
  deck — drop a finding, fix a severity, reword a slide — with your answers
  carried onto what it changes.
- **Acting on a review.** Fix the agreed findings in the right workspace, or
  post them to the merge request as properly anchored inline `DiffNote`s, or
  copy the notes as markdown. Only findings you agreed with are ever sent.
- **Agent tools and a skill**: `review_deck_changed_files`, `_create`,
  `_add_slide`, `_read`, `_edit`, `_finish`, plus a `bb review-deck` CLI.
- **A `/` skill menu** in every prompt box, over your real skill catalogue.
- Safety behaviour worth naming: stopping a review does not record the merge
  request as reviewed and restores the deck you had; one automatic attempt per
  commit, with a watch pausing itself after three failures; concurrent review
  requests spawn one agent, not two.

[Unreleased]: https://github.com/HundredBeans/bb-plugin-review-deck/compare/v0.3.0...HEAD
[0.3.0]: https://github.com/HundredBeans/bb-plugin-review-deck/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/HundredBeans/bb-plugin-review-deck/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/HundredBeans/bb-plugin-review-deck/releases/tag/v0.1.0
