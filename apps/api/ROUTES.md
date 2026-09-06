# API route contract

All routes use the `/api` global prefix. JSON errors contain `statusCode`, `error`, and `message`.

## Projects and setup

- `GET /projects`, `GET|PATCH|DELETE /projects/:projectId`; PATCH requires `expectedRevision`.
- `POST /project-sessions` — `{ logline, genreTags }`; title is deliberately rejected here and is always collected by the AI tool.
- `GET /project-sessions/:sessionId` — includes ordered `history` and opaque `stateToken` alongside the current step. Reading previous questions does not modify the session.
- `POST /project-sessions/:sessionId/respond` — `{ questionId, answer }`, `{ questionId, otherAnswer }`, or `{ questionId, skipOptional: true }`; required questions cannot be skipped. Choice answers must match the supplied options; nonempty `otherAnswer` is exclusive to choice questions and cannot accompany `answer`. New clients include zero-based `position` and `expectedState`; changing a previous answer invalidates later answers and the blueprint. An unchanged answer preserves them. Stale state returns 409.
- `POST /project-sessions/:sessionId/turn` — answer alias using `{ questionId, answer }`.
- `POST /project-sessions/:sessionId/skip` — skip the pending optional question; body `{ questionId? }`.
- `POST /project-sessions/:sessionId/commit` — optional `{ blueprint, expectedState }`; an edited blueprint is strictly validated, including its required title and 5–20 episode arc.

## Project AI chat

- `GET /projects/:projectId/chat/messages` — `{ messages }`, the persisted project conversation with message status (`PENDING`, `COMPLETE`, `FAILED`) and reviewable proposals.
- `POST /projects/:projectId/chat/messages` — `{ content, clientMessageId }`; returns `{ messages }` after the Luna response and proposals have been validated. Reusing a successful turn ID returns its saved result; a failed turn can be retried with the same ID and content. Reusing the ID with different content returns 409. Failed turns remain in history.
- `POST /projects/:projectId/chat/proposals/:proposalId/apply` — returns `{ proposal }`. Applies the stored proposal once, validating project ownership, target revision, and any affected active arcs in one transaction. Replaying an applied proposal returns the recorded result. Conflicting changes return 409. Memory indexing follows the commit and failed indexing is retried.

Chat uses `AI_CHAT_MODEL` (default `openai/gpt-5.6-luna`) for project-scoped read tools and proposal generation. Supported proposals are project information updates and Canon/arc/project-improvement creation, updates, and deletion. Global improvements are reference-only. Episodes may be read and analyzed; episode mutation and project deletion are not chat actions. Sending a chat message never applies a proposal automatically.

## Episodes and scene memory

- `GET|POST /projects/:projectId/episodes`; POST accepts an optional `Idempotency-Key` header and returns the original episode for an identical replay.
- `POST /projects/:projectId/episodes/propose` — `{ hint? }`
- `POST /projects/:projectId/episodes/generate` — `{ title, direction, targetChars? }`, NDJSON preview only.
- `GET|PATCH|DELETE /projects/:projectId/episodes/:episodeId`; PATCH and DELETE bodies require `expectedRevision`.
- `POST /projects/:projectId/episodes/:episodeId/continue` — `{ expectedRevision, cursorOffset, targetChars? }`, NDJSON preview only.
- `POST /projects/:projectId/episodes/:episodeId/finalize` — `{ expectedRevision }`; extracts summary/scene and pending Canon candidates. A fresh `CONFIRMED` revision is replay-safe. `NEEDS_REVIEW` is reviewed first; blocking issues return 422 with full `details.issues` and never replace or echo the user's manuscript.
- `POST /projects/:projectId/episodes/:episodeId/selection-replacements` — `{ expectedRevision, start, end, selectedText, replacement }`; exact UTF-16 selection replacement only. Candidate parsing is a separate request.
- `GET|PATCH /projects/:projectId/episodes/:episodeId/scene`; PATCH requires `expectedRevision`.

NDJSON events are `meta`, `stage`, `delta`, `reset`, `warning`, `done`, and `error`. Text remains a preview until a non-blocked `done`; the client then saves it through create/PATCH. Continuity repair retains the original preview until the corrected result passes review and arrives in `done`. Clients retain the last readable preview through `reset`, reject empty `done` and EOF without `done`, and ignore data after completion. Incomplete text can only be saved explicitly with review required.

## Canon, arcs, and improvements

- `GET|POST /projects/:projectId/canon`, `POST .../canon/generate`, `GET|PATCH|DELETE .../canon/:canonId`; PATCH requires `expectedRevision`.
  `CHARACTER_APPEARANCE` stores detailed freeform visual facts in `content`, separate from `CHARACTER`. AI-generated entries remain candidates until approved.
- `GET|POST /projects/:projectId/arcs`, `GET .../arcs/current`, `POST .../arcs/plan`, `PATCH|DELETE .../arcs/:arcId`; the plan route returns a strict AI proposal and PATCH requires `expectedRevision`.
  Activating a new arc archives the previously active arc.
- `GET|POST /improvements`, `PATCH|DELETE /improvements/:improvementId`; PATCH requires `expectedRevision`.
- `POST /improvement-candidates` — `{ source: 'EDITOR'|'COMPARISON', projectId?, original, revised }`; extracts improvements in the revised (after) manuscript relative to the original (before). For `COMPARISON`, the original can be an AI draft generated from a brief or a user-provided manuscript. Candidates are transient.
- `POST /improvements/batch` — `{ projectId?, candidates }`; only this call persists accepted candidates. Optional `Idempotency-Key` (client UUID recommended) makes an identical retry return the original `{ improvements }`; reuse with a different body returns 409. Every candidate is validated before one atomic SQLite transaction.
- `POST /comparisons/generate` — `{ brief, targetChars? }`, NDJSON. User-written text is forbidden and is compared later through `/improvement-candidates`.

## Operations

- `POST /projects/:projectId/memory/reindex`
- `POST /memory/reindex-global-improvements` — rebuilds keyword/vector chunks for every active GLOBAL improvement (for example after configuring embeddings).
- `GET /health`
