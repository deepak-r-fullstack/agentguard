import { z } from "zod";
import { env } from "../../config/env";
import { ConflictError, ForbiddenError, NotFoundError, ServiceUnavailableError } from "../../helpers/errors";
import { Workspace } from "../../models/workspace.model";
import type { ActionContext, ActionDefinition } from "../actions/actionRegistry";

// One private workspace, one repository, one pre-created label. Agents cannot
// supply URLs, credentials, repository names or replacement label lists.
const repositorySchema = z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/);
const issueSchema = z.object({
  number: z.number().int().positive(),
  title: z.string(),
  state: z.string(),
  updated_at: z.string(),
  labels: z.array(z.union([z.string(), z.object({ name: z.string() })])),
  pull_request: z.unknown().optional()
});
type Issue = z.infer<typeof issueSchema>;
const labelsOf = (issue: Issue) => issue.labels.map((label) => (typeof label === "string" ? label : label.name)).sort();
const sameLabels = (left: string[], right: string[]) => JSON.stringify([...left].sort()) === JSON.stringify([...right].sort());
const STALE = "The GitHub issue changed. Nothing was overwritten; inspect it before submitting a new request.";

export function isGitHubSandboxConfigured() {
  return (
    !env.DEMO_MODE &&
    Boolean(
      env.GITHUB_SANDBOX_TOKEN && repositorySchema.safeParse(env.GITHUB_SANDBOX_REPOSITORY).success && /^[a-f\d]{24}$/i.test(env.GITHUB_SANDBOX_WORKSPACE_ID)
    )
  );
}

async function assertSandbox(ctx: ActionContext) {
  if (!isGitHubSandboxConfigured()) throw new ServiceUnavailableError("The GitHub sandbox is not connected. It is disabled on public demo servers.");
  if (String(ctx.workspaceId) !== env.GITHUB_SANDBOX_WORKSPACE_ID) throw new ForbiddenError("This company cannot use the GitHub sandbox.");
  const workspace = await Workspace.findById(ctx.workspaceId).select("slug").lean();
  if (!workspace || ["acme-travels", "globex-holidays"].includes(workspace.slug))
    throw new ForbiddenError("Public demo companies cannot use the GitHub sandbox.");
}

// No redirects, no automatic retries of writes, bounded time and sanitized errors.
// A network failure after a write is ambiguous: an operator must inspect GitHub.
async function github(path: string, method = "GET", body?: unknown): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(`https://api.github.com/repos/${env.GITHUB_SANDBOX_REPOSITORY}${path}`, {
      method,
      redirect: "error",
      signal: AbortSignal.timeout(8000),
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${env.GITHUB_SANDBOX_TOKEN}`,
        "X-GitHub-Api-Version": "2022-11-28",
        "Content-Type": "application/json"
      },
      body: body === undefined ? undefined : JSON.stringify(body)
    });
  } catch {
    throw new ServiceUnavailableError("GitHub did not confirm the request. Check the issue before retrying; a write may already have happened.");
  }
  if (response.status === 404) throw new NotFoundError("The sandbox issue or label was not found, or its token cannot access it.");
  if (response.status === 401 || response.status === 403)
    throw new ForbiddenError("GitHub refused access. Check the sandbox token and its repository permissions.");
  if (!response.ok) throw new ServiceUnavailableError("GitHub could not complete the request. Inspect the issue before trying again.");
  if (response.status === 204) return null;
  try {
    return await response.json();
  } catch {
    throw new ServiceUnavailableError("GitHub returned an unreadable response. Inspect the issue before trying again.");
  }
}

async function readIssue(issueNumber: number) {
  const parsed = issueSchema.safeParse(await github(`/issues/${issueNumber}`));
  if (!parsed.success) throw new ServiceUnavailableError("GitHub returned an unexpected issue. Nothing else was requested.");
  const issue = parsed.data;
  if (issue.number !== issueNumber || issue.pull_request) throw new ConflictError("Choose an issue in the sandbox repository, not a pull request.");
  return issue;
}

const paramsSchema = z.object({ issueNumber: z.number().int().positive().max(2147483647) }).strict();
type Params = z.infer<typeof paramsSchema>;
const snapshotSchema = z.object({ repository: z.string(), label: z.string(), issueNumber: z.number(), labels: z.array(z.string()), updatedAt: z.string() });
type Snapshot = z.infer<typeof snapshotSchema>;

export const githubSandboxAction: ActionDefinition<Params, Snapshot> = {
  key: "github.addSandboxLabel",
  label: "Label a sandbox GitHub issue",
  description:
    "Adds the configured label to an issue in the private sandbox repository. A person always approves; undo removes only that label if the issue still matches the completed change.",
  irreversible: false,
  requiresApproval: true,
  paramsSchema,
  ruleFields: [{ path: "facts.issueNumber", label: "Issue number", type: "number" }],
  moneyFields: { facts: [], result: [] },
  exampleParams: { issueNumber: 1 },
  async prepare(params, ctx) {
    await assertSandbox(ctx);
    const issue = await readIssue(params.issueNumber);
    const labels = labelsOf(issue);
    if (labels.includes(env.GITHUB_SANDBOX_LABEL)) throw new ConflictError("This issue already has the sandbox label. Nothing was changed.");
    // Refuse missing labels rather than implicitly creating repository configuration.
    await github(`/labels/${encodeURIComponent(env.GITHUB_SANDBOX_LABEL)}`);
    return {
      facts: {
        issueNumber: issue.number,
        title: issue.title,
        repository: env.GITHUB_SANDBOX_REPOSITORY,
        label: env.GITHUB_SANDBOX_LABEL,
        labels,
        updatedAt: issue.updated_at
      },
      summary: `Add label "${env.GITHUB_SANDBOX_LABEL}" to ${env.GITHUB_SANDBOX_REPOSITORY} issue #${issue.number}: ${issue.title}`
    };
  },
  async snapshot(params, ctx) {
    await assertSandbox(ctx);
    const issue = await readIssue(params.issueNumber);
    const facts = ctx.approvedFacts;
    if (
      !facts ||
      facts.repository !== env.GITHUB_SANDBOX_REPOSITORY ||
      facts.label !== env.GITHUB_SANDBOX_LABEL ||
      facts.updatedAt !== issue.updated_at ||
      !Array.isArray(facts.labels) ||
      !sameLabels(facts.labels as string[], labelsOf(issue))
    )
      throw new ConflictError(STALE);
    return {
      repository: env.GITHUB_SANDBOX_REPOSITORY,
      label: env.GITHUB_SANDBOX_LABEL,
      issueNumber: params.issueNumber,
      labels: labelsOf(issue),
      updatedAt: issue.updated_at
    };
  },
  async run(params, ctx) {
    await assertSandbox(ctx);
    const snapshot = snapshotSchema.parse(ctx.beforeSnapshot);
    const before = await readIssue(params.issueNumber);
    if (before.updated_at !== snapshot.updatedAt || !sameLabels(labelsOf(before), snapshot.labels)) throw new ConflictError(STALE);
    await github(`/issues/${params.issueNumber}/labels`, "POST", { labels: [snapshot.label] });
    const after = await readIssue(params.issueNumber);
    if (!sameLabels(labelsOf(after), [...snapshot.labels, snapshot.label]))
      throw new ConflictError("The label request was sent, but GitHub changed concurrently. Inspect the issue; no automatic rollback was attempted.");
    return {
      issueNumber: params.issueNumber,
      repository: snapshot.repository,
      label: snapshot.label,
      labels: labelsOf(after),
      updatedAt: after.updated_at,
      url: `https://github.com/${snapshot.repository}/issues/${params.issueNumber}`
    };
  },
  async undo(rawSnapshot, ctx) {
    await assertSandbox(ctx);
    const snapshot = snapshotSchema.parse(rawSnapshot);
    // Configuration changes cannot redirect undo into another repository or label.
    if (snapshot.repository !== env.GITHUB_SANDBOX_REPOSITORY || snapshot.label !== env.GITHUB_SANDBOX_LABEL)
      throw new ConflictError("The sandbox connection changed. Inspect the original repository before undoing manually.");
    const current = await readIssue(snapshot.issueNumber);
    const result = ctx.completedResult;
    if (!result || current.updated_at !== result.updatedAt || !sameLabels(labelsOf(current), [...snapshot.labels, snapshot.label]))
      throw new ConflictError(STALE);
    // Delete just our label. Never PUT the old label list over newer labels.
    await github(`/issues/${snapshot.issueNumber}/labels/${encodeURIComponent(snapshot.label)}`, "DELETE");
    const restored = await readIssue(snapshot.issueNumber);
    if (!sameLabels(labelsOf(restored), snapshot.labels))
      throw new ConflictError("The label was removed, but the issue also changed. Inspect GitHub before retrying undo.");
  }
};
