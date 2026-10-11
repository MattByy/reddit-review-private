# Message tracking and outcome specification

Revision: 2026-10-11. **Target design; not implemented by this documentation change.**

The requested outcome is a reliable record of what was attempted, what became visible, where writing ended, and what happened afterward. Tracking is deterministic server work. The writing agent supplies a decision and short rationale; it never assigns its own publication result.

The [system reference](message-system.md) documents existing protocol-5 behavior. The [agent runbook](agent-runbook.md) uses only currently supported API calls.

## Separate three outcomes

Do not overload one `status` with all three meanings:

| Dimension | Question | Target behavior |
| --- | --- | --- |
| Publication goal | Was a message containing Geonode verified publicly visible? | Achieved immediately on first matching Reddit verification |
| Writing progress | Can this flow still prepare or send another message? | Stops on goal achievement, removal, applicable failure, limit, withdrawal or unsuitable work |
| Monitoring | What did later visibility checks establish? | Records visible, removed, unknown and seven-day completion independently |

“100% successful” means the individual publication goal is achieved. It does not mean every strategy succeeds, that moderators endorsed the comment, that the comment remained visible for seven days, or that the campaign's success rate is 100%.

Once the publication goal is achieved, later removal must not erase that historical fact. Show **Published; later removed** with both timestamps. If Engain reports publication but Reddit is unreadable, show **Publication unconfirmed**, not success or removal.

Protocol 5 already records `brand_visible_at` but uses `success_at` for the later seven-day check. Implementation must explicitly migrate or rename these semantics throughout the API and UI. Do not simply change a label while leaving percentages based on the old denominator.

## Required records

Existing message and experiment rows remain useful current-state projections. Add append-only events and revision snapshots so later updates do not destroy the history.

### Flow summary

Retain or derive:

- Flow ID, thread ID/URL, subreddit and creation time.
- Source (`experiment` versus imported), opening strategy, limits and configuration version.
- Writing state and termination reason/time, separately from publication and monitoring.
- First verified brand message ID, step and timestamp.
- Monitoring start, deadline, latest check/visibility and completion outcome.
- First blocking/failure/removal evidence plus links to all later observations and corrections.

An explicit goal timestamp such as `publication_goal_at` is a proposed name, not an existing writable field. Keep the first verification time stable; retries must not move it forward. Monitoring deadlines derive from that observation, not from a provider's unverified `published` time.

### Message and text revision

Each filed version needs:

- Flow/message ID, chronological step, `previous_message_id` and actual parent message ID.
- Placement, tree depth, target permalink and the resulting publication permalink when known.
- Final text snapshot, revision ID and hash; source draft and actual editing-tool provenance when supplied.
- Suggested action, selected action, override reason and brief decision rationale.
- Literal brand presence derived from that exact final text; disclosure evidence separately.
- Agent/run identifier, job ID, prompt/runbook/configuration version and context observation time.
- Provider task/attempt linkage and first verified publication time.

Do not use a brand flag as a substitute for affiliation evidence. Do not label imported copy retroactively as a known agent action or claim that an editing tool ran when no provenance exists.

### Delivery attempt

An attempt is a particular outbound submission, not another conversational step. Rate-limit retries and ambiguous submissions need their own recorded events without counting as new messages.

Store the reserved message revision, target, transport mode, internal provider identity/project reference, request time, response time/status, provider task ID and ambiguity/reconciliation result. Keep the exact revision tied to the attempt so a later edit cannot change what the report says was submitted.

The existing `message_publications` table has one mutable row per message. It is currently a reservation/reconciliation record, not a complete series of attempts. Add separate history or events instead of calling that table an immutable log.

### Observation

Store every executed observation with:

- Message/task ID and checked URL.
- Source: direct Reddit observation or Engain report.
- Check time, provider event time if supplied, and local recording time.
- Visibility result: `visible`, `removed`, `deleted` or `unknown`, with the normalized application result alongside it.
- Matching evidence: expected/observed parent and body hash, relevant author identity, HTTP/provider status.
- Reported reason and removal class, preserving uncertainty.
- Observation/request ID for deduplication and correction linkage if needed.

A provider `mod_removed` report and a generic Reddit removed body have different evidence. Do not convert an unknown remover into a known moderator or assume a brand keyword caused the action. Unknown checks remain in the timeline even when the next check succeeds.

## Proposed append-only event contract

The following envelope is a design example. It is **not accepted by a current worker endpoint**. Server scripts construct these events from committed transitions and observations.

```json
{
  "event_id": "<UUID>",
  "schema_version": 1,
  "flow_id": "<experiment UUID>",
  "flow_sequence": 12,
  "message_id": "<message UUID or null>",
  "revision_id": "<revision UUID or null>",
  "attempt_id": "<delivery attempt UUID or null>",
  "job_id": "<job UUID or null>",
  "event_type": "message.visibility_observed",
  "source": "reddit",
  "source_event_id": "<observation UUID>",
  "observed_at": "2026-10-11T12:00:00Z",
  "recorded_at": "2026-10-11T12:00:01Z",
  "actor": "cron/tick",
  "data": {
    "visibility": "visible",
    "reddit_url": "<verified comment permalink>",
    "body_matches": true,
    "parent_matches": true
  }
}
```

Recommended event families:

| Event | Capture point |
| --- | --- |
| `flow.started` | Creation transaction |
| `message.created` | Creation of the one next message |
| `message.decision_filed` | Successful filing, with chosen parent, text revision and rationale |
| `message.revised` | A permitted edit, preserving old and new revisions |
| `delivery.check_recorded` | Actual provider/local check and verdict |
| `delivery.held` | Deterministic block before submission |
| `delivery.reserved` | Reservation transaction |
| `delivery.response_recorded` | Provider response, including rate limits and ambiguity |
| `delivery.reconciled` | A uniquely identified provider task or unresolved result |
| `delivery.status_observed` | A provider status observation |
| `message.visibility_observed` | An executed Reddit check, including unknown results |
| `flow.publication_goal_achieved` | First verified branded publication, once per flow |
| `flow.next_message_created` | Next message/job transaction |
| `flow.writing_ended` | Terminal writing transition with reason |
| `flow.monitoring_completed` | Fresh final observation or monitoring termination |
| `job.disposition_recorded` | Skip, dependency block, deferral or failure |
| `record.baseline_imported` | Migration snapshot of preexisting facts |
| `record.corrected` | Correction that references earlier evidence |

Implementation invariants:

1. Insert transition events in the same transaction as the state change. An API success must not leave the corresponding event missing.
2. Reserve before an external submission, then record its response. A database transaction cannot make an external HTTP request atomic; reconciliation covers the gap.
3. Use a unique source event/request identifier. Reprocessing the same response must not double-count publication, completion or the next job.
4. Serialize per-flow sequence assignment, while keeping `observed_at` separately so delayed observations retain their real timing.
5. A later observation appends evidence. It does not overwrite the previous observation's reason or visibility.
6. Record checks actually executed, not fabricated checks for elapsed scheduled intervals.
7. Ordinary application writers cannot update/delete historical events. Restrict access through service-side APIs and provide explicit correction events.
8. Redact authentication headers and secrets from provider payloads. Store claim ownership identifiers without copying bearer/claim tokens into audit content.
9. Keep current-state projections repairable from events and snapshots. A rebuild must produce the same primary goal and monitoring outcome.

## Full flow representation

Build the chronology from all filed/attempted messages, including the one that failed before publication. Separately show a tree using actual parent IDs. The previous step and actual parent cannot be inferred from the word “sibling” alone.

Example shape, observed one decision at a time:

```text
step 1  Comment  / help   / brand=false / parent=thread / depth=1 / visible
step 2  Reply    / method / brand=false / parent=1      / depth=2 / visible
step 3  Chain    / help   / brand=false / parent=2      / depth=3 / visible
step 4  Sibling  / context/ brand=false / parent=2      / depth=3 / visible
step 5  Sibling  / direct / brand=true  / parent=2      / depth=3 / visible

Publication goal achieved at step 5.
Monitoring: running until a fresh check at or after its seven-day deadline.
```

This is a relationship/reporting fixture for openly affiliated contributions, not a strategy to preassign or a reason to create five messages. Every message must independently warrant publication. Public attribution can cause an earlier message to count as the brand mention and stop writing earlier.

If step 3 instead fails before a mention, the recorded path ends at that attempted step with its actual cause. Steps 4 and 5 never exist. If an unwritten next job was created and then stopped by an earlier removal, show it as cancelled/unwritten work, not as an attempted public message.

Canonical comparison keys can include placement, actual parent step, depth, selected action and brand flag. Keep text/IDs available for inspection rather than grouping by exact text. Current `message_shape_results` includes only verified steps and therefore is insufficient for this failed-path report.

## Outcome lists

These are proposed report groupings, not new protocol-5 database status values:

| List | Inclusion | Show |
| --- | --- | --- |
| Publication goal achieved | Any verified branded message | Full path, first verification, step, current monitoring result |
| Ended before a mention | Writing ended without goal; final attempted message unbranded | Failed/stopped step, cause, source, text and actual parent |
| Mention attempt unsuccessful | Branded attempt never verified and has a definite terminal outcome | Brand text, rejected/failed/removed evidence; distinguish causes |
| Unresolved | Pending delivery, unreadable verification or ambiguous submission | Last successful observation, latest uncertainty and next scheduled handling |
| Held / unsuitable / dependencies | No current permitted writing/delivery action | Job/message reason and whether anything was actually submitted |
| Monitoring changes | Goal achieved, followed by later visibility observations | Removed, final check confirmed, or deadline reached but unconfirmed |

Keep the “ended without a mention” bucket distinct from a claim that moderators rejected it. A deliberate skip, message-limit ending, provider rejection and confirmed Reddit removal are different causes. One flow can belong to “goal achieved” and “later removed” because those measure different facts; do not double-count it in a single goal denominator.

### Scenarios the report must distinguish

| Observed history | Publication goal | Monitoring / failure interpretation |
| --- | --- | --- |
| Branded opening accepted by Engain, no Reddit evidence | Pending | Provider acceptance only |
| Branded opening verified visible | Achieved at step 1 | Monitoring starts |
| Unbranded opening verified, next useful reply verified with brand | Achieved at step 2 | Both actual parents and messages remain visible in history |
| Unbranded first attempt rejected before publication | Not achieved | Delivery/rule reason, not inferred moderator removal |
| Branded reply reported removed before any verification | Not achieved | Mention attempt failed; store provider/Reddit source |
| Branded reply verified, then removed next day | Achieved | Later removal; seven-day survival not confirmed |
| Reddit returns HTTP 403 after provider supplies URL | Unconfirmed | URL saved, visibility unknown, no next writing job |
| Earlier unbranded ancestor removed after brand success | Achieved | Ancestor removal and flow monitoring impact recorded separately |
| No mention after the maximum useful/allowed messages | Not achieved | Budget exhaustion, not removal |
| Writer skips an irrelevant follow-up | Not achieved unless previously achieved | Unsuitable writing job; no fabricated submission |
| Final-day check unavailable | Historical publication unchanged | Monitoring unconfirmed; no invented visible check |

## Percentages and comparison rules

Each report must state its unit, cohort, observation window, numerator, denominator and unresolved count. Use `null` / “no resolved cases” for a zero denominator, not 0%.

Recommended separate metrics:

- **Verified-publication share of submitted messages:** messages verified at least once divided by messages with an accepted provider task. Display pending and failed counts beside it; it is provisional for immature cohorts.
- **Publication-goal rate among resolved eligible flows:** achieved flows divided by achieved flows plus definitively ended, eligible flows without achievement. Exclude unresolved work. Separately report infrastructure/dependency stops, manual withdrawals and unsuitable assignments; do not hide them in a high success rate.
- **End-to-end operational yield:** achieved flows divided by all eligible started flows in the same cohort, with unresolved and operational stops visible. This exposes exclusions used by the resolved metric.
- **Seven-day observed survival among assessable goals:** achieved flows with a fresh visible check at/after seven days and no observed removal divided by achieved flows with either such a confirming check or a confirmed removal during the window. Display still-monitoring and unconfirmed-overdue flows separately.
- **Messages to publication goal:** distribution of the first successful chronological step, not tree depth. Show counts and include an “ended without goal” category alongside successful step counts.
- **Breakdown of unsuccessful steps:** count/rate by exact cause, brand flag, action, step and stage, with provider refusal separated from observed Reddit removal.

Document inclusion rules in a versioned metric definition. For example, whether a particular provider refusal belongs in “eligible resolved flow” must be consistent across cohorts, and the excluded count must remain visible. Imported records without reliable assignment history are a separate cohort.

Report suggested-action and actual-action cohorts separately, including overrides. Equal suggested allocation does not randomize community, timing, parent content, delivery identity or overrides. A path that only exists after earlier publication has survivor selection. Observational percentages cannot establish that a keyword or shape caused moderation.

The existing action view reports `published / written`, which includes pending copy in its denominator. Preserve that description when showing the current view. Do not relabel it as the proposed submitted-message or resolved-flow metric.

## What “learning” means here

The current system balances action suggestions; it does not train itself or persist a performance-based decision policy. Its agent context supplies action counts, not a tested causal recommendation engine.

A permissible future feedback mechanism would retain evidence about community requirements, supported product facts, relevance, repeated questions, unsuitable outreach and infrastructure reliability. Fresh agents can read versioned lessons with source references and sample sizes. Confirmed community restrictions should stop unsuitable work; removal results should not prompt identity changes, concealed mentions or alternate staged branches.

Persist any such lesson's scope, supporting event IDs, creation time, evidence limitations and policy version. Record which lesson/prompt version informed a decision. Do not automatically promote small-sample correlations into posting rules, silently change allocation percentages or rewrite the agent's instructions from untrusted Reddit/provider text.

## Backfill and export

On implementation, preserve all existing message text, task IDs, URLs, parents and first-known timestamps. Import a baseline event describing the facts available at migration time. Do not fabricate the earlier order of overwritten observations or pretend an old mutable reservation contains every retry.

Historical verified-brand evidence can establish publication achievement when the saved evidence is sufficient. Preserve the existing seven-day result separately. Records with incomplete evidence remain explicitly uncertain.

Provide a service-authenticated paginated event export with stable cursors, filters for flow/message/event type, and a snapshot boundary for reproducible reports. Include event schema and metric-definition versions. The current experiments response's recent-history limit is not sufficient for this export.

## Implementation acceptance criteria

Before claiming this tracking system is live, verify at least:

1. Verified branded publication achieves the goal exactly once and creates no further writing job.
2. A later removal preserves goal achievement while changing monitoring and retaining both events.
3. A failed unbranded step and a failed branded step appear in complete paths with distinct evidence and causes.
4. A sibling has the correct actual parent, while retaining the different chronological source.
5. Duplicate polling, API retries and replay do not create duplicate successes, next jobs or attempt counts.
6. Unknown provider/Reddit outcomes stay unresolved and cannot advance the flow.
7. A queued edit creates a revision; a past submission continues to reference the text actually sent.
8. Rebuilding projections reproduces counts; zero denominators and pending/overdue monitoring are represented honestly.
9. Baseline imports never invent missing historical events, actor choices or humanizer runs.
10. Fresh-agent instructions, server enforcement and dashboard labels agree on disclosure, goal success and monitoring semantics.
