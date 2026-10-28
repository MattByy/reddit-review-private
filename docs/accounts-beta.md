# Accounts Beta: deferred private-account reference

**This is not the active setup path. Start with [pooled delivery](pooled-accounts.md).**

Accounts Beta is the repository's existing integration for private Reddit accounts exposed by Engain. It requires a specific available `userAccountId`. It is separate from pooled tasks, where Engain allocates the posting account.

| Concern | Pooled: active phase | Accounts Beta: deferred |
| --- | --- | --- |
| Account supplied by | Engain's pool | Available private integration account |
| Transport setting | `ENGAIN_DELIVERY=pool` | `ENGAIN_DELIVERY=private` |
| Posting payload | `projectId`, `url`, `content` | `userAccountId`, `targetUrl`, `body` |
| Task lookup | `/api/v1/tasks/{taskId}` | Paginated private comments feed |
| Publication URL field | `redditUrl` | `resultUrl` |
| Writer account selection | None | Also a server concern; not part of the writing decision |

## Existing adapter contract

The [Engain Accounts Beta OpenAPI](https://docs.engain.io/api/engain-accounts-openapi.json) is now publicly documented (as of 2026-10). The repository's existing integration uses:

- `GET /api/v1/accounts-beta/accounts`: returns `accounts` with `userAccountId`, `username`, `karma`, `accountAge`, `usable`, `isReadyForSelection` and `status`.
- `POST /api/v1/accounts-beta/comments`: uses `{userAccountId, targetUrl, body, scheduledFor?}` for a comment or reply.
- `GET /api/v1/accounts-beta/comments`: paginated `page`, `isDone`, `continueCursor`; task `taskId`, `status`, `resultUrl`.
- `GET /api/v1/accounts-beta/comments/thread-check?userAccountId&threadUrl`: returns `hasExistingComment` (true if account already commented on thread).
- `POST /api/v1/accounts-beta/comments/{id}/cancel`: cancellation request.

The shared queue still owns message IDs, parents, task persistence, verification and duplicate prevention. Private identities do not permit disguising affiliated participation as independent customers. Account availability is not evidence of disclosure or permission to participate in a community.

## Do not enter this path during the pooled trial

A missing pooled project, provider error or unreadable Reddit thread is a pooled setup/observation problem. Report the actual failure. Do not enable private delivery, provide `userAccountId` to a pooled task, or call Accounts Beta from the writing agent.

The server's `auto` setting may select private delivery when no pooled project is selected. That is why the pooled guide specifies explicit `ENGAIN_DELIVERY=pool`. Existing private tasks, if any, remain observable according to their saved transport; a pooled-only writer does not manage them.

Before any future private phase, independently verify this beta contract, configure authorized representation and test it separately. None of the pooled setup commands configures or starts that phase.
