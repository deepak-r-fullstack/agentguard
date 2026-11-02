import assert from "node:assert/strict";
import crypto from "node:crypto";

// Explicit opt-in. Credentials come from the process environment and are never
// printed or written to disk. Use a fine-grained token for this sandbox only.
async function main() {
  if (process.env.RUN_GITHUB_SANDBOX_SMOKE !== "true") throw new Error("Set RUN_GITHUB_SANDBOX_SMOKE=true only for your disposable sandbox repository.");
  assert.ok(process.env.GITHUB_SANDBOX_TOKEN, "Set a sandbox-only token");
  assert.ok(process.env.GITHUB_SANDBOX_REPOSITORY, "Set the disposable repository");
  const issueNumber = Number(process.env.GITHUB_SANDBOX_ISSUE || "1");
  assert.ok(Number.isSafeInteger(issueNumber) && issueNumber > 0);
  process.env.NODE_ENV = "test";
  process.env.DEMO_MODE = "false";
  process.env.JWT_SECRET = "local-live-smoke-test-secret";
  process.env.GITHUB_SANDBOX_WORKSPACE_ID = crypto.randomBytes(12).toString("hex");
  process.env.TEST_MONGO_URI = ""; // always use a disposable local database
  process.env.AGENTREPLAY_API_KEY = "";
  const { startTestDb, stopTestDb } = await import("../server/tests/helpers/testDb");
  const { Workspace } = await import("../server/src/models/workspace.model");
  const { Agent } = await import("../server/src/models/agent.model");
  const { requestAction, approveAction, undoAction } = await import("../server/src/services/actions/guard.service");
  const { generateApiKey } = await import("../server/src/services/auth/auth.service");
  await startTestDb();
  try {
    const workspace = await Workspace.create({ _id: process.env.GITHUB_SANDBOX_WORKSPACE_ID, slug: "private-live-smoke", name: "Private live smoke" });
    const key = generateApiKey();
    const agent = await Agent.create({ workspaceId: workspace._id, name: "Sandbox smoke agent", apiKeyHash: key.apiKeyHash, apiKeyPreview: key.apiKeyPreview });
    const record = await requestAction(agent, {
      action: "github.addSandboxLabel",
      params: { issueNumber },
      onBehalfOf: "support@sandbox.test",
      reason: "Disposable live integration test",
      idempotencyKey: crypto.randomUUID()
    });
    assert.equal(record.status, "pending_approval");
    const reviewer = { type: "user" as const, id: crypto.randomUUID(), name: "Sandbox reviewer", email: "reviewer@sandbox.test" };
    const completed = await approveAction(workspace._id, String(record._id), reviewer);
    assert.equal(completed.status, "done", completed.errorMessage);
    const undone = await undoAction(workspace._id, String(record._id), reviewer);
    assert.equal(undone.status, "undone");
    console.log("LIVE PASS: GitHub proposal → pending approval → label added → label removed by undo. Original labels preserved.");
  } finally {
    await stopTestDb();
  }
}
main().catch((error) => {
  console.error(error instanceof Error ? error.message : "Live smoke failed");
  process.exitCode = 1;
});
