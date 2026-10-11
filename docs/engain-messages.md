# Engain message delivery contract

Reviewed 2026-10-11 against [Engain's API reference](https://docs.engain.io/) and its [OpenAPI document](https://docs.engain.io/api/openapi.json). Server: `https://api.engain.io`; authentication: `X-API-Key`. General limit: 30 requests/minute; rule checking has a separate 5/minute limit.

## Pooled delivery

`GET /api/v1/me` returns accessible `projects`. The API requires a project for tasks and rule checking.

| Request | Required fields | Meaning |
| --- | --- | --- |
| `POST /api/v1/tasks/comment` | `projectId`, `url`, `content` | Top-level comment on a post URL |
| `POST /api/v1/tasks/reply` | `projectId`, `url`, `content` | Reply to an exact comment permalink |
| `GET /api/v1/tasks/{taskId}` | Task ID in path | Current status, `redditUrl`, content and target |
| `GET /api/v1/tasks` | Query `projectId` | Paginated tasks; `numItems`, `cursor`, `createdAfter` supported |
| `POST /api/v1/tasks/{taskId}/cancel` | Task ID in path | Request cancellation if eligible |

Creation returns a task `id`; lookup/list records use `_id`. Task lists return `page`, `isDone`, `continueCursor`. The task's target is `threadUrl` and its publication is `redditUrl`. Labels identify our experiment/message for reconciliation. The implementation omits `rank` (upvote boosting) and the optional `posterAccount` slot, leaving pooled account allocation to Engain. `userAccountId` is not a pooled task parameter.

`/tasks/thread` exists for fully planned thread groups; this application does not use it because each reply depends on a newly observed outcome.

## Checks and observations

`POST /api/v1/rule-check` requires `projectId`, `subreddit`, `taskType` and `content`. We supply `mediaKind: text`, post URL/title/body, and for replies both `context.parentCommentUrl` and `context.parentComment`. Engain requires at least one of those parent fields for a reply. Subreddit and supplied URL must agree.

`pass`, `warn`, `fail`, `skipped`, and `unavailable` are advisory verdicts. Scores such as `removalRisk`, `authenticityRisk`, and `marketingIntentRisk`, plus `violatedRules`, `summary`, and `contextWarnings`, are stored as returned. No cached rules means `skipped`, not a pass. Unavailable checks retry; an explicit rule failure holds the text for revision. A warning does not become a hidden arbitrary risk-score threshold.

Provider states are distinct:

- `scheduled`, `in_review` (waiting for pickup), `in_queue`, `waiting_for_mod_approval`, `waiting_for_parent_comment`: work pending, no proof of visibility.
- `published`: provider reports publication; verify the exact returned comment on Reddit.
- `automod_removed`, `mod_removed`, `user_deleted`, `main_comment_removed_deleted`: removal/deletion with the corresponding reported class.
- `post_url_broken`, `subreddit_private_banned`, `incorrect_missing_flair`, `thread_archived_locked`, `cancelled`, `error`: delivery failure/refusal, not successful publication.
- Unknown/new statuses are preserved; they do not advance a message without Reddit evidence.

Cancellation is limited to eligible tasks stuck in `in_review` for more than 24 hours. Engain may reject cancellation once work has started (`409`). The application stops future messages immediately and shows cancellation as pending when the provider cannot confirm it.

## Existing private integration

The current public OpenAPI does **not** document `accounts-beta`. The private fallback therefore preserves this repository's established integration rather than inventing a pooled/private shared payload:

- `GET /api/v1/accounts-beta/accounts`: `accounts` with `userAccountId`, `profileUsername`, `usable`.
- `POST /api/v1/accounts-beta/comments`: `{userAccountId,targetUrl,body}` for both top-level comments and replies.
- `GET /api/v1/accounts-beta/comments`: paginated `page`, `isDone`, `continueCursor`, task `_id`, `status`, `resultUrl`.
- `POST /api/v1/accounts-beta/comments/{id}/cancel`: cancellation request.

An eligible provider account is selected automatically, avoiding the previous private account when alternatives exist. No UI selection or approval is required. Without an accessible project, rule checking is explicitly recorded as unavailable for this integration (`skipped`, `source=no_project`), while fresh Reddit target checks and publication verification still run. Ambiguous private submissions require an exact account/body/target match and a compatible provider creation timestamp before recovery; missing evidence leaves them uncertain.
