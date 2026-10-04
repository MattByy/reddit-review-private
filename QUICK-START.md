# Batch Approve — Quick Reference

## Feature Overview

**Problem**: 30 pending drafts require 30 individual approve clicks

**Solution**: Skim all drafts in a grid, select the reviewed set, approve all at once with one button click

## How It Works

1. **Open review page** → https://site-phi-two-38.vercel.app/review
2. **Batch mode auto-shows** when ≥10 drafts pending
3. **Skim the grid** → Each row shows title, sub, kind, strategy, state
4. **Select drafts** → Click checkboxes for drafts you've reviewed and want to approve
5. **Review the count** → "X of Y selected" updates live
6. **Click button** → "Approve selected" → RPC runs on all selected drafts
7. **See results** → Status message shows count approved + any per-draft errors
8. **Drafts move** → Approved ones appear on "Sending" tab, dispatch runs

## Key Behaviors

| Scenario | What Happens |
|----------|--------------|
| No drafts selected | "Approve selected" button stays disabled |
| Some drafts have validation issues | Those rows show red, checkboxes disabled, can't select them |
| Reply draft without confirmed parent | Row shows red, disabled, message says why |
| Draft is redirect_pending | Row shows red, disabled (waiting for agent body) |
| Approve 5 drafts at once | All 5 write draft_revisions + activity_log entries in one transaction |
| Batch approval fails | Error message shows which drafts failed and why; no partial approvals |
| All drafts approved | Batch mode toggles back to single-draft, shows empty state |
| Want to go back | Click "Back to single review" button to switch modes |

## UI Layout (Desktop)

```
┌─ Batch review ────────────────────────────────────┐
│ ☐ Select all          12 of 30 selected [Approve] │
├───────────────────────────────────────────────────┤
│ ☐ "iPhone vs Android..." r/homelab  reply reply ✓ │
│ ☑ "Best tool for X"    r/webscraping comment ✓ ● │
│ ☐ "Need help with..."  r/proxies    post ✓ ⚠    │
│ ☑ "Question about..."  r/scraping   reply reply ✓ │
│ ☒ "Can I use..."       r/dataharvesting reply ✗ │
│   [text in red: "reply parent is one of our own"] │
│ ... (25 more) ...                                  │
├───────────────────────────────────────────────────┤
│ Status: Approved 5. Sending to Engain…            │
└───────────────────────────────────────────────────┘
```

## Mobile View (≤900px)

```
┌─ Batch review ────────────────────────────┐
│ ☐ All    12 of 30      [Approve selected] │
├─────────────────────────────────────────┤
│ ☑ "iPhone vs Android..."  reply ✓      │
│ ☐ "Best tool for X"       reply ✓  ●   │
│ ☒ "Need help with..."     post ✗       │
│   [error: reply parent issue]           │
│ ... (27 more) ...                       │
│ [Back to single review]                 │
└─────────────────────────────────────────┘
```

Notes:
- Subreddit hidden on mobile (shown in title context)
- All info still visible: title, kind, strategy, state
- Checkboxes and buttons remain accessible

## Error Handling

If some drafts fail validation during approval:

```json
{
  "successful": 24,
  "withErrors": 1,
  "message": "Approved 24 drafts. 1 had issues: draft was sent back to the agent (mode sharpen) and no new body has arrived"
}
```

Failed drafts stay in the grid (not removed), human can fix them individually on single-draft tab.

## RPC Signature

```
approve_draft_batch(
  p_draft_ids uuid[],  -- array of draft IDs to approve
  p_note text,         -- approval note (e.g., "Batch approved by reviewer")
  p_editor text        -- editor name (e.g., "reviewer")
) returns table (
  draft_id uuid,
  thread_id text,
  kind text,
  mode text,
  body text,
  status text,         -- 'approved' if successful
  error text           -- null if success, error message if failed
)
```

## Constraints Still Enforced

✅ Each draft validates before approval
✅ Reply parent confirmation required
✅ Can't approve if redirect_pending
✅ Atomic all-or-nothing: all success, or report per-draft failures
✅ Gate checks still happen before posting (check_draft.py)
✅ No automation: human selects + clicks button

## Timeline

- **Current**: 30 pending drafts
- **With batch approve**: ~10 seconds to skim, select, approve all (vs. 5+ minutes one-by-one)
- **Future**: Scales to any count (capped at 100 per batch RPC)

## Keyboard & Accessibility

| Action | Key | Notes |
|--------|-----|-------|
| Toggle all | Checkbox click | Visual feedback on indeterminate state |
| Toggle one | Checkbox click | Real-time count update |
| Approve | Button click | Disabled when no selections |
| Go back | Button click | Any time, no loss of selection |
| Review one | Click title | Returns to single-draft mode, opens that draft |

## Rollback

If issues: `vercel rollback` (revert to previous deploy, no DB cleanup needed)

## What's Next

After deployment verification:
1. Monitor activity_log for `"batch": true` entries
2. Verify Engain receives batched tasks normally
3. Check Supabase logs for transaction issues
4. Gather user feedback on UX

---

**Status**: ✅ Ready for deployment
