# API route contract

All routes use the `/api` global prefix. JSON errors contain `statusCode`, `error`, and `message`.

## Projects and setup

- `GET /projects`, `GET|PATCH|DELETE /projects/:projectId`; PATCH requires `expectedRevision`.
- `POST /project-sessions` — `{ logline, genreTags }`; title is deliberately rejected here. The AI's first question must provide an editable title recommendation.
- `GET /project-sessions/:sessionId` — includes ordered `history` and opaque `stateToken` alongside the current step. Reading previous questions does not modify the session.
- `POST /project-sessions/:sessionId/respond` — `{ questionId, answer }`, `{ questionId, otherAnswer }`, or `{ questionId, skipOptional: true }`; required questions cannot be skipped. The optional target-episode question always follows the title: a whole number from 5 through 2,000 records a user ending, while skipping delegates the ending length to AI. Choice answers must match the supplied options; nonempty `otherAnswer` is exclusive to choice questions and cannot accompany `answer`. New clients include zero-based `position` and `expectedState`; changing a previous answer invalidates later answers and the blueprint. An unchanged answer preserves them. Stale state returns 409.
- `POST /project-sessions/:sessionId/turn` — answer alias using `{ questionId, answer }`.
- `POST /project-sessions/:sessionId/skip` — skip the pending optional question; body `{ questionId? }`.
- `POST /project-sessions/:sessionId/commit` — optional `{ blueprint, expectedState }`; an edited blueprint is strictly validated. It includes the reviewed title, detailed initial Canon, ending target/source, and one or more 5–20 episode arcs that cover episode 1 through the ending without gaps or overlaps. The first arc is committed as `ACTIVE`; later arcs are committed as `PLANNED`. Project, Canon, arcs, and the session transition commit atomically. Canon and the active arc are indexed afterward, and replaying a committed session retries that indexing safely.

## Project AI chat

- `GET /projects/:projectId/chat/threads` — rooms ordered by most recent activity, with `id`, `projectId`, `title`, `createdAt`, `updatedAt`, a bounded `preview`, `messageCount`, and `status` (`PENDING`, `COMPLETE`, `FAILED`, or `null` for an empty room).
- `POST /projects/:projectId/chat/threads` — accepts an optional `{ clientThreadId }` and returns a new empty room. Reusing the same ID in the same project returns the existing room. The title is set from the first message. Existing conversations are automatically preserved in one room per project during migration.
- `GET /projects/:projectId/chat/threads/:threadId/messages` — `{ thread, messages }`, the selected room's persisted conversation with message status (`PENDING`, `COMPLETE`, `FAILED`) and reviewable proposals. Missing rooms or rooms belonging to another project return 404.
- `POST /projects/:projectId/chat/threads/:threadId/messages` — `{ content, clientMessageId }`; returns `{ thread, messages }` after the Luna response and proposals have been validated. AI conversation context and pending-turn checks are scoped to this room. Reusing a successful turn ID returns its saved result; a failed turn can be retried with the same ID and content. Reusing the ID with different content or in another room returns 409. Failed turns remain in history.
- `GET /projects/:projectId/chat/messages` — compatibility endpoint returning the most recently active room, or `{ thread: null, messages: [] }` when none exists.
- `POST /projects/:projectId/chat/messages` — compatibility endpoint that sends to the most recently active room, creating one if needed. A retry or replay of an existing message ID stays in its original room.
- `POST /projects/:projectId/chat/proposals/:proposalId/apply` — returns `{ proposal }`. Applies the stored proposal once, validating project ownership, target revision, and any affected active arcs in one transaction. Replaying an applied proposal returns the recorded result. Conflicting changes return 409. Memory indexing follows the commit and failed indexing is retried.

Chat uses `AI_CHAT_MODEL` (default `openai/gpt-5.6-luna`) for project-scoped read tools and proposal generation. Image-tag requests are recognized in the same chat without a separate route or UI: the chat model calls `generate_image_tags` once with confirmed `CHARACTER_APPEARANCE`/`LOCATION` IDs and optional scene direction, then a nested `AI_IMAGE_TAG_MODEL` run (default `openai/gpt-5.6-luna`) returns validated lowercase Danbooru-style tags. This tool does not call an image API or create a Canon proposal. Supported proposals are project information updates and Canon/arc/project-improvement creation, updates, and deletion. Global improvements are reference-only. Episodes may be read and analyzed; episode mutation and project deletion are not chat actions. Sending a chat message never applies a proposal automatically.

## Episodes and scene memory

- `GET /projects/:projectId/episodes/:episodeId/editor-ai/messages` — persisted episode editing conversation, isolated from project chat and other episodes.
- `POST /projects/:projectId/episodes/:episodeId/editor-ai/messages` — `{ content, clientMessageId, expectedRevision, selection: { start, end, text } }`. UTF-16 range must match the saved revision. Uses `AI_WRITING_MODEL` with novel-writing context. A nonempty selection limits edits to `replace_selection`. Equal start/end allows `replace_text` to choose a range using an exact, unique `original` quote, `read_manuscript` to read omitted text (UTF-16 `start`, `length` up to 20,000), or `insert_at_cursor` to add prose at the supplied cursor. Returns `{ messages }` with at most one before/after edit card per reply; generation never changes the manuscript. Identical successful requests replay; failed requests can retry the same input/ID. Concurrent turns in the same episode or stale revisions return 409.
- `POST /projects/:projectId/episodes/:episodeId/editor-ai/messages/:messageId/apply` — returns `{ episode, message }`. Atomically applies the stored edit and marks it applied, checking ownership, exact revision and original range. Repeated application returns the current episode without applying again. Changed manuscripts return 409; editing invalidates chronological memory as with manual changes.

- `GET|POST /projects/:projectId/episodes`; POST accepts an optional `Idempotency-Key` header and returns the original episode for an identical replay. `{ title, direction, content?, incomplete?, forceNeedsReview? }` creates an `INCOMPLETE` plan when `incomplete: true` and content is empty; otherwise it creates a draft.
- `GET /projects/:projectId/episodes/order` — returns `{ episodes, slots, revision }`. `slots` contains episode IDs or `null` placeholders, starting at episode 1, including reserved trailing slots.
- `PUT /projects/:projectId/episodes/order` — `{ slots, expectedRevision }`; atomically reorders and renumbers episodes, returning the updated order snapshot. Every current episode must appear exactly once; only existing placeholders may be removed. Stale snapshots return 409. Reordering invalidates affected chronological memories and in-flight AI results.
- `POST /projects/:projectId/episodes/propose` — `{ hint?, episodeId?, expectedRevision? }`
- `POST /projects/:projectId/episodes/refine` — `{ title, direction, instruction }`; all fields require nonblank strings (maximum 200, 20,000, and 5,000 characters respectively). Returns `{ title, direction, conflicts }`, improving only the requested parts of the supplied current plan while retaining the rest. Repeated calls use the latest edited/refined title and direction. Refreshes project memory like propose; never saves the refined plan as an episode.
- `POST /projects/:projectId/episodes/generate` — `{ title, direction, targetChars? }`, NDJSON preview only.
- `POST /projects/:projectId/episodes/repair` — `{ title, direction, content, issue }`, NDJSON preview only. Repairs the single supplied continuity issue (warning or blocking) in an unsaved full draft, then reviews the corrected draft once and returns all remaining/new issues.
- `GET|PATCH|DELETE /projects/:projectId/episodes/:episodeId`; PATCH and DELETE bodies require `expectedRevision`. PATCH accepts `incomplete` to retain an empty plan or start writing with `incomplete: false`.
- `POST /projects/:projectId/episodes/:episodeId/continue` — `{ expectedRevision, cursorOffset, targetChars? }`, NDJSON preview only.
- `POST /projects/:projectId/episodes/:episodeId/repair` — `{ expectedRevision, cursorOffset, content, issue }`, NDJSON preview only. Repairs only the continuation candidate in `content` using the stored episode's cursor boundaries; checks the base revision before work and again before `done`.
- `POST /projects/:projectId/episodes/:episodeId/finalize` — `{ expectedRevision }`; extracts summary/scene and pending Canon candidates. A fresh `CONFIRMED` revision is replay-safe. `NEEDS_REVIEW` is reviewed first; blocking issues return 422 with full `details.issues` and never replace or echo the user's manuscript.
- `POST /projects/:projectId/episodes/:episodeId/selection-replacements` — `{ expectedRevision, start, end, selectedText, replacement }`; exact UTF-16 selection replacement only. Candidate parsing is a separate request.
- `GET|PATCH /projects/:projectId/episodes/:episodeId/scene`; PATCH requires `expectedRevision`.

New episodes append after the final slot, or start at 1 when no slots remain. Deleting the final real slot releases that number; deleting an interior episode leaves a placeholder. Placeholder positions survive reloads, including layouts with only placeholders. Existing counters are normalized once on migration to the final live episode number plus one.

`propose`, `refine`, `generate`, and full-draft `repair` accept the paired `episodeId` and `expectedRevision` fields to use a saved episode's number and preceding memory. Targeted generation requires an empty episode and does not save the streamed result. The client saves the generated plan once, reuses its ID for refinements, then streams and reviews the full draft in the editor before saving with PATCH.

NDJSON events are `meta`, `stage`, `delta`, `reset`, `warning`, `done`, and `error`. Streaming endpoints never persist the manuscript; the client saves through create/PATCH. Continuity repair retains the original preview until the corrected result passes review and arrives in `done`. Clients retain the last readable preview through `reset`, reject empty `done` and EOF without `done`, and ignore data after completion. The full-episode editor saves the completed draft after review. Blocked results and interrupted partial manuscripts are saved with `forceNeedsReview: true`; interruptions before any text retain `INCOMPLETE`. Continuation and repair previews still require the user to apply them.

Selective repair emits `MEMORY`, `REPAIRING`, and `CHECKING` stages, without replacement deltas or resets. It never saves episode content or automatically repairs further issues found on review. `done` contains `{ content, issues, blocked, baseRevision? }`; remaining blocking issues keep the preview blocked. `issue` must have the continuity-review shape (`category`, `severity`, `excerpt`, `explanation`, `evidenceRefs`, `repairInstruction`) with a nonempty explanation or repair instruction.

## Canon, arcs, and improvements

- `GET|POST /projects/:projectId/canon`, `POST .../canon/generate`, `GET|PATCH|DELETE .../canon/:canonId`; PATCH requires `expectedRevision`.
  `CHARACTER_APPEARANCE` stores detailed freeform visual facts in `content`, separate from `CHARACTER`. AI-generated entries remain candidates until approved.
- `GET|POST /projects/:projectId/arcs`, `GET .../arcs/current`, `POST .../arcs/plan`, `PATCH|DELETE .../arcs/:arcId`; list results are ordered by episode range. New arcs may be `PLANNED` or `ACTIVE`. The plan route returns a strict AI proposal for the earliest writable range: it repairs a gap before later plans first, or revises the planned arc that starts there in place with `replaceArcId` and `replaceArcRevision`, preserving its exact range. A new plan cannot cross the next planned arc or the project's ending target, and must reach that boundary or leave at least five episodes for another arc.
- Arc PATCH requires `expectedRevision`. `PLANNED` arcs are freely editable, but only the earliest contiguous planned arc may become `ACTIVE`; editing `ACTIVE` plan fields requires `confirmProtected: true`. `COMPLETE` and `ARCHIVED` arcs are read-only and cannot be reactivated. Activating a future arc marks the previous current arc `COMPLETE` when its range has been written, or `ARCHIVED` when it is replaced early; early replacement requires explicit confirmation.
- Arc DELETE requires `{ expectedRevision }` and only removes a `PLANNED` future arc. Stale revisions and deletion of current or past arcs return 409.
- `GET|POST /improvements`, `PATCH|DELETE /improvements/:improvementId`; PATCH requires `expectedRevision`.
- `POST /improvement-candidates` — `{ source: 'EDITOR'|'COMPARISON', projectId?, original, revised }`; extracts improvements in the revised (after) manuscript relative to the original (before). For `COMPARISON`, the original can be an AI draft generated from a brief or a user-provided manuscript. Candidates are transient.
- `POST /improvements/batch` — `{ projectId?, candidates }`; only this call persists accepted candidates. Optional `Idempotency-Key` (client UUID recommended) makes an identical retry return the original `{ improvements }`; reuse with a different body returns 409. Every candidate is validated before one atomic SQLite transaction.
- `POST /comparisons/generate` — `{ brief, targetChars? }`, NDJSON. User-written text is forbidden and is compared later through `/improvement-candidates`.

## Operations

- `POST /projects/:projectId/memory/reindex`
- `POST /memory/reindex-global-improvements` — rebuilds keyword/vector chunks for every active GLOBAL improvement (for example after configuring embeddings).
- `GET /health`
