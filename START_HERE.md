# Start here: pooled delivery first

**Current phase: use Engain's pooled accounts. Accounts Beta is deferred.**

The agent writes one message and files it with our API. Our scripts submit it to Engain, save the task ID and comment URL, and check publication. Engain chooses the posting account. You do not connect, choose, rotate or approve our own Reddit accounts.

## 1. Choose the correct section

| Section | Use now? | Start point |
| --- | --- | --- |
| **Pooled accounts** | **Yes** | [Pooled setup and first test](docs/pooled-accounts.md) |
| Accounts Beta / our private accounts | No; deferred | [Separate reference](docs/accounts-beta.md) |

## 2. Follow this order

1. Read [Pooled setup and first test](docs/pooled-accounts.md). It distinguishes the agent's API from Engain's API and lists the required settings.
2. Run `npm ci`, then `npm run pool:test`. This is a local test with simulated external services; it never posts to Reddit.
3. With `AGENT_API_KEY` supplied by the runner or an ignored `.env.local`, run `npm run pool:check`. It only reads `/bootstrap` and `/delivery`. Require `ok: true` before continuing; this proves current API connectivity, not that a comment has published.
4. For the first live test, follow the pooled guide's **one-message test** on a designated permitted thread in an isolated test queue. Do not send arbitrary fixture text or claim unrelated queued work.
5. For each actual writing turn, use [the daily agent runbook](docs/agent-runbook.md). It contains the prompt, exact fields, decision criteria and recovery instructions.

There is no new publishing approval step. Filing a final message queues automatic delivery. An unfinished draft belongs in a job checkpoint, not in the filing endpoint.

## 3. Give a fresh agent this instruction

```text
Read START_HERE.md, then docs/pooled-accounts.md.
We are using pooled delivery only; Accounts Beta is deferred.
Run the read-only pooled connection check before claiming work.
Use docs/agent-runbook.md for each writing job.
File one relevant, clearly attributed message through our agent API.
Our server handles Engain, task IDs, URLs, polling and tracking.
Do not call Engain directly or configure private accounts.
Report saved IDs and observed states; do not call a queued message published.
```

## Reference only when needed

- [Full system](docs/message-system.md): queues, limits, states and script ownership.
- [Engain contract](docs/engain-messages.md): provider fields for the server adapter.
- [Tracking specification](docs/message-tracking.md): planned audit and reporting changes, explicitly separated from current functionality.

Protocol 5 stops writing when a branded message is verified, but currently confirms `success_at` after seven-day monitoring. Immediate-success reporting and append-only tracking are still specifications. No docs or test command installs the daily agent runner or configures a humanizer.
