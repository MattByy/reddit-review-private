# Script hierarchy and bulk review fix

Investigation and implementation: 5 October 2026. Local changes; not deployed or applied to production.

## Findings

The base `drafts` table stores individual text. Migration 018 already supplies the correct hierarchy: `scenarios` is a reusable template, `scenario_runs` is a script instance, and `scenario_acts` is its ordered segment membership. Each act references a draft. Migration 024 supplies whole-script review and an exact-content snapshot.

The UI confused membership with `drafts.mode`: `assets/app.js` labelled an individual scenario draft “script”, while `review.html` also listed the same draft in the ordinary comment queue. Scripts were always expanded and lacked segment review controls. Status had a strategy badge but no script navigation.

Bulk review had several distinct problems:

- `renderBatchGrid()` registered another Select All listener on every render.
- Error/success feedback used `hidden=false` while the element still had inline `display:none`.
- Missing accounts and unconfirmed reply parents made rows unselectable. This is an eligibility condition, not permission to remove the send gates. The screen now explains blocked rows and disables Select All when none qualify.
- There was no way to reopen batch mode after leaving it, or use it with fewer than ten drafts.
- Selection could survive row changes. Partial success discarded failed selections, and duplicate clicks could submit overlapping requests.
- Migration 032 copied approval checks and directly updated drafts instead of calling `review_draft`. It also emitted an extra synthetic error row when every item failed. Its use of an output column named `status` alongside an unqualified SQL `status` reference could also cause PL/pgSQL ambiguity. These are source findings; no production RPC or database was inspected.

## Data model and behaviour

```text
scenarios (template)
  └─ scenario_runs (script, optional narrative_type)
       └─ scenario_acts (ordered segment, unique draft membership)
            └─ drafts (comment/reply text and individual review state)
```

Migration 033 extends this model instead of creating a competing `scripts` table:

- One draft can belong to at most one segment. Sequence numbers must be positive, and a dependency must reference an earlier segment in the same script.
- `script_segments` exposes the hierarchy and separates review status from publication status.
- `script_review_state` computes effective approval for open scripts, so stale snapshot approvals are not displayed as current permission.
- Whole-script approval requires at least two planned and filed segments. Legacy one-segment runs remain visible as incomplete; no historical rows are silently moved or deleted.
- `review_script_segment` supports edit, approve and reject through `review_draft`, retains revisions, and invalidates prior parent release. Already-sent segments cannot be changed through it. Existing permanent-rejection rules remain.
- `approve_draft_batch` delegates to the correct review function, locks rows, returns one result per distinct requested ID and isolates per-item failures. Reviewing a segment does not release its parent.
- Existing sender readiness, timing, account, disclosure and publication checks remain in place.

Review renders expandable parent containers with ordered segments, individual review controls, review/publication indicators and whole-script approval. Unsaved segment edits prevent parent approval. Script membership removes segments from the standalone queue. Status links carry the script ID and open that full narrative, including a script older than the default 50-run window.

Bulk Select All applies to eligible standalone comments. Script segments have their own controls inside the parent narrative. Blocked rows explain what must change. Errors stay visible, failed selections survive partial success, and a failed Sending refresh does not undo or misreport a committed approval.

## Test narratives

`tests/fixtures/review-scripts.json` and its SQL counterpart contain:

| Narrative | Segments | Progression |
| --- | ---: | --- |
| Product announcement | 4 | Introduction, workflow, limitations, next step |
| Educational tutorial | 5 | Define success, classify outcomes, retries, failure tests, verification |
| Illustrative case study | 3 | Problem, change, lesson |

All copy is explicitly fictional test material with operator disclosure. SQL fixtures use a locked test thread and future eligibility. The integration test wraps them in a rollback transaction. Do not load these fixtures into production.

## Validation and application

Passed here: 33 Node tests (7 new regressions), `node checkpages.js`, `node checkrules.js`, Python syntax parsing and `git diff --check`.

Not verified here: real-browser execution, SQL migration execution and production behaviour. Chrome launch failed under the session sandbox. PostgreSQL initialization failed at shared-memory allocation. No live migration, review approval, Reddit submission or deployment was attempted.

Before deployment:

1. On an isolated database with the existing schema through migration 032, inspect any duplicate `scenario_acts.draft_id` memberships. The unique index deliberately aborts on ambiguity rather than choosing an owner. Ordering and parent constraints are `NOT VALID` for historical data; they enforce new writes. Audit and validate old rows separately.
2. Apply `supabase/migrations/033-script-review-hierarchy.sql`, then run `psql "$TEST_DATABASE_URL" -v ON_ERROR_STOP=1 -f tests/script-review.sql`. The SQL suite checks all three narratives, individual versus parent permission, edit invalidation, rejection, mixed bulk outcomes, duplicate IDs, empty batches and incomplete scripts.
3. Run `python3 tests/review-browser.py` where Playwright and Chrome can launch. It intercepts every request, exercises the real pages, and cannot reach vendor or production endpoints. It checks grouping, selection, visible errors, retry, segment edits, whole-script review and Status drill-down.
4. Apply the migration before deploying the page, because the new page uses the new views and RPC. Deployment remains a separate step.
