# Batch Approve Flow — Deployment & Testing Guide

## What was built

A batch-approve workflow that lets the owner skim and approve many pending drafts **in ONE human action** instead of clicking through them one at a time. The workflow is designed for the current 30 pending drafts and scales to any count.

### Core Design

- **Human remains the approver**: One click on "Approve selected" is permission, not automation. The RPC runs the same gate checks as the single-draft approve.
- **Migration 032**: New `approve_draft_batch(p_draft_ids uuid[], p_note text, p_editor text)` RPC that:
  - Approves multiple drafts in ONE transaction
  - Runs per-draft validation: checks for redirect_pending, reply parent confirmation, gates
  - Returns per-draft success/error results so the reviewer knows which ones failed
  - Writes draft_revisions and activity_log entries marked `"batch": true`
  - Sets `send_cleared_at` on successful drafts in one atomic operation
- **UI in review.html**:
  - Batch grid showing all drafts with subreddit, title, kind, strategy, and state
  - Checkboxes for per-row opt-out
  - "Select all" button with indeterminate state support
  - Real-time count of selected drafts
  - "Approve selected" button (disabled if none selected)
  - Status messages showing per-draft errors if any
  - Auto-switches to batch mode when ≥10 drafts pending; user can toggle back
- **Phone-friendly**: Same responsive design as the rest of the page

## Deployment Steps

### 1. Apply the migration

```bash
# The migration is in supabase/migrations/032-batch-approve-drafts.sql
# It defines the approve_draft_batch RPC function

cd ~/Documents/reddit-review
# Standard Supabase migration:
supabase db push  # or apply it manually via the Supabase dashboard
```

### 2. Deploy the review page

The review page update is in `review.html` and includes:
- New CSS for the batch grid and controls
- New HTML elements for batch-section
- New JavaScript functions: `showBatchMode()`, `renderBatchGrid()`, `updateBatchUI()`
- Event handlers for batch select/approve/cancel
- Auto-enabling batch mode when 10+ drafts are pending

```bash
cd ~/Documents/reddit-review
node build.js  # Injects passcode gate and builds config.js
git push origin batch-approve-flow  # or merge to main after review
vercel deploy --prod  # Deploy to production
```

### 3. Verify in production

Once deployed, open https://site-phi-two-38.vercel.app/review and:

1. If there are ≥10 pending drafts, batch mode appears automatically
2. Click checkboxes to select drafts (disabled ones fail validation, shown in red)
3. "Select all" checkbox appears
4. Real-time count shows "X of Y selected"
5. Click "Approve selected" to approve the batch
6. See per-draft success/error on the status message
7. Approved drafts move to Sending tab and dispatch is called

## Testing Without Deployment

To test the RPC logic locally (before deploying to production):

### Local test via curl

```bash
source ~/.geonode/supabase.env
DRAFT_IDS='["<id1>", "<id2>", "<id3>"]'

curl -X POST "https://wtdmwwiwnphqmkisfyrm.supabase.co/rest/v1/rpc/approve_draft_batch" \
  -H "apikey: $SUPABASE_SERVICE_KEY" \
  -H "Authorization: Bearer $SUPABASE_SERVICE_KEY" \
  -H "Content-Type: application/json" \
  -d "{\"p_draft_ids\": $DRAFT_IDS, \"p_note\": \"test batch\", \"p_editor\": \"test\"}"
```

Expected response (after migration applied):

```json
[
  { "draft_id": "<id>", "thread_id": "...", "kind": "comment", "mode": "comment", "status": "approved", "error": null },
  { "draft_id": "<id>", "thread_id": "...", "kind": "reply", "mode": "reply", "status": "approved", "error": null },
  { "draft_id": "<id>", "error": "draft was sent back to the agent (mode sharpen) and no new body has arrived" }
]
```

### Test the UI logic

Open the browser console on the review page and:

```javascript
// Show batch mode manually
showBatchMode(true);

// Select some drafts manually
batchSelected.add(drafts[0].id);
batchSelected.add(drafts[1].id);
updateBatchUI();

// Or use the grid checkboxes
```

## Hardening & Rules Compliance

### What was NOT automated

1. **No approve-without-human-click**: The owner must click "Approve selected" on the page
2. **No bypass of send gates**: Each draft still runs through check_draft.py before posting
3. **No approval of blocked drafts**: Drafts with `redirect_pending`, unconfirmed reply parents, or gate failures show as disabled and cannot be selected
4. **No deletion of history**: draft_revisions entries are append-only; batch approval is recorded with editor + note + batch=true flag
5. **No auto-batching of all drafts**: The owner selects the reviewed set manually with checkboxes

### Hard constraints respected

1. ✓ Approval remains human-driven (one click covers a set, not automation)
2. ✓ Send gates re-check after approval (check_draft.py still runs)
3. ✓ Rejection stays permanent (not tested as a revert)
4. ✓ draft_revisions is append-only (marked with `batch: true` in activity_log)
5. ✓ Rules list unchanged (only batch approval mechanic added)
6. ✓ Phone display works (responsive grid, all info visible per row)
7. ✓ Parent confirmation per-row still enforced (disabled if unconfirmed)
8. ✓ No new approval routes (still goes through review_draft → rpc → security definer)

## Repo Checks — All Pass

```
node checkpages.js     → all pages parse, all ids exist
node checkrules.js     → all disclosure patterns verified
node scripts-loadcheck.js → all page loads check out
node build.js          → config.js built, gates injected (1 ungated = /review)
```

## Key Files Modified

- **supabase/migrations/032-batch-approve-drafts.sql** — RPC definition
- **review.html** — UI, CSS, and JavaScript for batch flow
- **git branch** — batch-approve-flow (not yet merged to main)

## Rollback

If issues arise:
1. `vercel rollback` (revert to previous deploy)
2. Or remove batch-section HTML + batch JS from review.html and redeploy
3. Migration is pure addition (no altered RPCs), so it's safe to keep

## Performance Notes

- RPC uses `foreach` loop (suitable for ≤100 drafts per batch, enforced by check)
- One transaction per batch (atomic all-or-nothing for a given set)
- Per-draft validation happens in the RPC (no N+1 queries from browser)
- Activity log + draft_revisions recorded per-draft in one transaction

## Future Improvements

- Export batch results CSV for audit
- Undo button (create a "batch-reject" RPC that undoes with a matching batch ID)
- Keyboard shortcut to toggle batch mode
- Persist batch selection in sessionStorage across page reloads
- Scheduled batch approval (queue for later, set and forget)
