# API route contract

All routes use the `/api` global prefix. JSON errors contain `statusCode`, `error`, and `message`.

## Projects and setup

- `GET /projects`, `GET|PATCH|DELETE /projects/:projectId`; PATCH requires `expectedRevision`.
- `POST /project-sessions` — `{ logline, genreTags }`; title is deliberately rejected here and is always collected by the AI tool.
- `GET /project-sessions/:sessionId`
- `POST /project-sessions/:sessionId/respond` — `{ questionId, answer }` or `{ questionId, skipOptional: true }`; required questions cannot be skipped.
- `POST /project-sessions/:sessionId/turn` — answer alias using `{ questionId, answer }`.
- `POST /project-sessions/:sessionId/skip` — skip the pending optional question; body `{ questionId? }`.
- `POST /project-sessions/:sessionId/commit` — optional `{ blueprint }`; an edited blueprint is strictly validated, including its required title and 5–20 episode arc.

## Episodes and scene memory

- `GET|POST /projects/:projectId/episodes`; POST accepts an optional `Idempotency-Key` header and returns the original episode for an identical replay.
- `POST /projects/:projectId/episodes/propose` — `{ hint? }`
- `POST /projects/:projectId/episodes/generate` — `{ title, direction, targetChars? }`, NDJSON preview only.
- `GET|PATCH|DELETE /projects/:projectId/episodes/:episodeId`; PATCH and DELETE bodies require `expectedRevision`.
- `POST /projects/:projectId/episodes/:episodeId/continue` — `{ expectedRevision, cursorOffset, targetChars? }`, NDJSON preview only.
- `POST /projects/:projectId/episodes/:episodeId/finalize` — `{ expectedRevision }`; extracts summary/scene and pending Canon candidates. A fresh `CONFIRMED` revision is replay-safe. `NEEDS_REVIEW` is reviewed first; blocking issues return 422 with full `details.issues` and never replace or echo the user's manuscript.
- `POST /projects/:projectId/episodes/:episodeId/selection-replacements` — `{ expectedRevision, start, end, selectedText, replacement }`; exact UTF-16 selection replacement only. Candidate parsing is a separate request.
- `GET|PATCH /projects/:projectId/episodes/:episodeId/scene`; PATCH requires `expectedRevision`.

NDJSON events are `meta`, `stage`, `delta`, `reset`, `warning`, `done`, and `error`. Text remains a preview until a non-blocked `done`; the client then saves it through create/PATCH.

## Canon, arcs, and improvements

- `GET|POST /projects/:projectId/canon`, `POST .../canon/generate`, `GET|PATCH|DELETE .../canon/:canonId`; PATCH requires `expectedRevision`.
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
