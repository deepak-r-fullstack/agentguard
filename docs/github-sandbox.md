# GitHub sandbox: one real external action

The optional `github.addSandboxLabel` action adds one pre-created label to an issue, waits for human approval, and offers a compensating undo. Agents supply only `issueNumber`. Repository, label and credentials are server-owned.

## Isolation and setup

Use a **separate private deployment and private workspace**, not the public portfolio demo. The connector refuses to work when `DEMO_MODE=true`, for a different workspace, or for either seeded public demo company (Acme / Globex). Switching demo mode off alone does not turn those public accounts into private accounts.

1. Create a disposable GitHub repository and a practice issue. Pre-create the label `agentguard-demo`.
2. Use an existing private AgentGuard workspace with privately managed users and agent keys. This connector does not provision accounts. Do not reuse demo credentials or enable demo seeding.
3. Create a fine-grained GitHub token limited to that repository, with Issues read/write permission. Set it through your host's secret controls. Never paste it into the browser's action JSON.
4. Configure:
   - `DEMO_MODE=false`, `SEED_ON_START=false`
   - `GITHUB_SANDBOX_TOKEN`: sandbox-only token
   - `GITHUB_SANDBOX_REPOSITORY=owner/disposable-repo`
   - `GITHUB_SANDBOX_WORKSPACE_ID`: the private workspace ObjectId
   - `GITHUB_SANDBOX_LABEL=agentguard-demo` (default)
5. Restart the service. The action is exposed in the action catalog / MCP only when configuration is present and demo mode is off.

Submit through REST with your private agent key:

```json
{
  "action": "github.addSandboxLabel",
  "params": { "issueNumber": 1 },
  "onBehalfOf": "support@example.test",
  "idempotencyKey": "a-new-unique-request-id"
}
```

No write occurs until a different authorized manager approves. Even a wildcard allow rule cannot skip this action's approval requirement. A deny rule still blocks it. Undo remains a signed-in manager/admin operation.

## What is checked

The proposal reads the real issue title, current labels and update timestamp. Approval refuses if those facts changed. Execution checks again after taking a snapshot. Undo checks the completed version and removes only the configured label; it never replaces the entire label list. A changed connection cannot redirect an old undo to another repository.

Requests use a fixed HTTPS GitHub API host, strict input schemas, an eight-second timeout, no redirects, no automatic write retries, and sanitized errors. Agent-supplied URLs, repository names and label lists are rejected.

## Limits that matter

GitHub's label endpoints do **not** provide an atomic compare-and-swap contract. A human can still change the issue in the interval between the final GET and the POST/DELETE. Timestamp checks are also limited by the precision GitHub supplies. These checks reduce conflicts; they do not guarantee isolation against concurrent GitHub edits.

A timeout can happen after GitHub accepted a write. The action is marked failed with an explicit instruction to inspect the issue. It is not retried or reversed automatically. A post-write verification failure can likewise mean the label changed even though the action reports failed. Resolve the external state manually before submitting a new idempotency key.

This is a constrained sandbox integration, not a claim of production-wide rollback or exactly-once delivery across systems.

## Tests

- `npm test`: approval, deny rules, retries, competing approval/undo clicks, cross-company access, changed records, configuration changes, invalid params, GitHub permissions/not-found/rate-limit/server failures, and ambiguous timeouts.
- `npm run check:browser`: built booking walkthrough in desktop and phone Chromium using disposable local MongoDB. Set `CHROME_PATH` when using an existing Chrome installation.
- Live smoke: run `node --import tsx checks/github-smoke.ts` with `RUN_GITHUB_SANDBOX_SMOKE=true`, the sandbox variables above and optional `GITHUB_SANDBOX_ISSUE=1`. It creates only a disposable local database and verifies a real add/undo cycle. It never reads or writes the hosted database. If it fails after an external write, inspect the issue and remove the sandbox label manually before rerunning. Live credentials are not required by CI.

The implementation was smoke-tested against a private disposable repository. That test does not configure credentials on Render or enable the integration on the public demo.

## Validation record

Validated locally on 2 November 2026:
- Full AgentGuard API suite, including pre-existing Slack, MCP, team, audit, money and recovery cases, plus guided-demo and GitHub adapter scenarios.
- Desktop and phone browser flows completed request, approval, verified cancellation, undo, history and deep-link refresh.
- The real private sandbox issue completed a proposal/approval/add-label/undo cycle and was checked to have its original empty label list afterward.
- Builds and TypeScript checks passed. Compatible transitive body-parser and follow-redirects patches were applied.
- The production audit still reports Zod (high) and React Router packages (moderate). A major-version migration / separate dependency review remains; these tests are not a security certification.

When AgentReplay recording is configured, the walkthrough returns a queued recording link to `/runs?externalId=<SDK id>`. Deploy the companion AgentReplay exact-ID filter before exposing these links. The link requires sign-in to the matching recording workspace and does not grant access. It records the request before approval; inspect later approval and undo in AgentGuard.
