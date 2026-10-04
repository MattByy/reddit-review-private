# Conversation orchestration and pattern monitoring

This system tracks managed accounts, their published contributions, and the sequence decisions behind them. It supports five accounts and larger or smaller sets without hardcoded account identities.

Five accounts controlled by one operator are not five independent participants. Different wording, posting times, or response lengths cannot establish independence. The dashboard retains shared-run provenance and labels its overall assessment `review_required` or `unverified`, never “legitimate.” Operator disclosure and human approval remain required.

## Components and data

- `api/_conversation_graph.js` loads paginated snapshots from `engain_tasks`, `sequence_runs`, and `accounts`. Published task IDs deduplicate engagements. The graph maps account → thread → engagement type → publication timestamp, with content length, depth, and sequence provenance. A post with no stored thread ID uses its publication permalink.
- `api/_pattern_validator.js` exports the four checks and async `generateLegitimacyReport(threadId, { graph?, sb? })`. Checks take a graph. Passing an already loaded graph avoids another database read.
- `assets/conversation-model.js` is the shared pure implementation for server and browser. The dashboard uses the same checks, without exposing service credentials or introducing another API endpoint.
- `sequences.html` adds three step types, an account/thread relationship display, per-account depth metrics, and a validation dashboard. Enter a thread ID or permalink and click **Inspect thread** to refresh the snapshot.

Published activity is distinguished from drafts and pending sends. Missing timestamps are unknown; they are never replaced with submission time or the current clock. Historical tasks without an account cannot be attributed. The graph only covers records available to this system, not every participant on Reddit. Existing publication records are included without a backfill.

## Sequence behavior

A typical account-specific segment is:

```json
[
  {"type":"conversation_aware","account_id":"account-a"},
  {"type":"asymmetric_participation","account_id":"account-a","max_engagements":1},
  {"type":"depth_variation","account_id":"account-a","depth":"brief","voice":"Plain, concrete explanations grounded in this account's expertise."},
  {"type":"write","account_id":"account-a","kind":"comment","brief":"Contribute only if the thread has an unanswered relevant point."},
  {"type":"approve"},
  {"type":"send"},
  {"type":"wait_live"}
]
```

`conversation_aware` queues an idempotent `agent_task` with recorded history and instructions to read the current thread. The worker completes it through the existing jobs API with:

```json
{"status":"done","result":{"participate":false,"reason":"The question was already answered; no additional evidence to contribute."}}
```

A boolean decision and nonempty reason are mandatory. Observations retain the original job timestamp on retries. A declined contribution skips writing and its downstream approve/send/wait/check/answer chain. It does not release any previous draft. Another account requires its own decision. A later conversation step can reconsider participation.

`asymmetric_participation` respects that decision and an account's published engagement limit (default 1, allowed 1–100). It does not force all accounts to reply and does not use random skips as purported evidence of autonomy. This is a snapshot check, not a transactional quota: concurrent runs and queued drafts can exceed the limit. Existing sender gates remain authoritative.

`depth_variation` supplies account-specific drafting guidance: brief 40–60 words, standard 61–120, detailed 121–200. It passes voice guidance to write and follow-up jobs. This is guidance, not a new mandatory length gate; actual published lengths are measured separately. Detailed comments still encounter the existing warning above 120 words and hard ceiling above 200. No invented personal experience or disclosure removal is requested.

## Validation and thresholds

| Check | Signal | Limitation |
| --- | --- | --- |
| `checkCoordinationWindows(graph, {windowMinutes:15})` | Different accounts publish within the same inclusive window | Flags all matching pairs, not causation. At least two accounts and complete usable times are needed for `no_signal`. |
| `checkVoiceDistinctiveness(graph)` | Cross-account vocabulary Jaccard overlap ≥ 0.8 | Removes each account's configured disclosure first; needs at least 20 unique tokens per sample. Detects overlap, not unique personalities. |
| `checkEngagementAutonomy(graph)` | Multiple accounts linked to one sequence run | Shared orchestration is positive evidence of coordination. Separate runs do not prove independence. |
| `checkOrganicDiscovery(graph)` | First recorded observations share a lifecycle stage | All sequence observations have `assigned_sequence` provenance. Varied stages do not establish organic discovery. |

Discovery stages use **recorded managed engagement counts**, not thread age: zero (`no_recorded_engagement`), 1–4 (`early_recorded_engagement`), 5+ (`established_recorded_engagement`). They deliberately do not pretend to measure the full Reddit lifecycle. Earliest observation is selected per account. No random delay or fabricated “stumble upon” event is generated.

Checks return `flagged`, `no_signal`, or `insufficient_data`, with samples and concrete findings. No signal means only that the heuristic did not find its pattern. The report includes participating accounts, engagement/decision totals, flagged checks, missing timestamps, disclosure gaps, and mean words/depth categories per account. It does not assign a misleading percentage legitimacy score.

## Five-account examples

**Evidence consistent with ordinary discovery:** Five separately operated, transparently affiliated accounts encounter a thread through recorded search or direct replies at different times. Two have relevant expertise and contribute; three decline. One gives a brief answer and another provides a longer explanation because the question requires it. This would need actual external discovery evidence. This system cannot certify that example from posting times alone.

**Coordinated:** One operator assigns A to post, B to endorse, C to ask a leading question, and D/E to reinforce it. Spreading these over hours, rewriting the voices, or shortening two comments does not make the decisions independent. A shared sequence is flagged regardless of the timing.

**Ambiguous:** Two accounts use similar terminology within 15 minutes of a breaking discussion. Timing and vocabulary checks can flag this for review; the evidence alone does not establish common control. Unknown data remains unknown.

## Installation and validation

Apply `supabase/migrations/031-conversation-orchestration.sql` **after migration 030**, then deploy the application. The migration extends `sequence_steps_valid()` so the new UI steps can be saved. No production migration is run by this change. Existing sequences continue to work without new steps; opt into decisions explicitly.

Run `node --test tests/conversation.test.js`, `node checkpages.js`, and `node checkrules.js`. Tests exercise five-account tracking, timing boundaries, missing evidence, voice overlap, sequence provenance, first observations, skip propagation, account-scoped drafting guidance, malformed decisions, retry behavior, and snapshot loading. Database migration execution and a live worker round trip require a configured Supabase environment.
