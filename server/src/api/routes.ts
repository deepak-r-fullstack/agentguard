import { Router } from "express";
import rateLimit from "express-rate-limit";
import { env, isTest } from "../config/env";
import { asyncHandler } from "../helpers/asyncHandler";
import { authenticateAgent, authenticateUser, authorizeRoles } from "../middlewares/auth.middleware";
import { validateRequest } from "../middlewares/validateRequest.middleware";
import { policyInputSchema } from "../services/policy/policySchemas";

import * as authController from "../controllers/auth.controller";
import * as agentApiController from "../controllers/agentApi.controller";
import * as actionsController from "../controllers/actions.controller";
import * as policiesController from "../controllers/policies.controller";
import * as auditController from "../controllers/audit.controller";
import * as agentsController from "../controllers/agents.controller";
import * as demoController from "../controllers/demo.controller";
import * as mcpController from "../controllers/mcp.controller";
import { NotFoundError } from "../helpers/errors";

const router = Router();

// Rate limits: slow down password guessing and runaway agent loops.
const loginLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: isTest ? 1000 : 20, standardHeaders: true, legacyHeaders: false });
const agentLimiter = rateLimit({ windowMs: 60 * 1000, limit: isTest ? 10000 : 120, standardHeaders: true, legacyHeaders: false });

const demoOnly = (_req: unknown, _res: unknown, next: (err?: unknown) => void) =>
  env.DEMO_MODE ? next() : next(new NotFoundError("Demo features are turned off."));

router.get("/health", (_req, res) => {
  res.json({ success: true, message: "AgentGuard is running." });
});

// ---------- people: sign in ----------
router.post("/auth/login", loginLimiter, validateRequest(authController.loginSchema), asyncHandler(authController.loginUser));
router.get("/auth/me", authenticateUser, asyncHandler(authController.getCurrentUser));

// ---------- agents: the guarded API ----------
router.get("/agent/catalog", agentLimiter, authenticateAgent, asyncHandler(agentApiController.getAgentCatalog));
router.post(
  "/agent/actions",
  agentLimiter,
  authenticateAgent,
  validateRequest(agentApiController.agentActionRequestSchema),
  asyncHandler(agentApiController.submitAgentAction)
);
router.get("/agent/actions/:id", agentLimiter, authenticateAgent, asyncHandler(agentApiController.getAgentActionStatus));

// ---------- agents: MCP (Model Context Protocol), same guard behind it ----------
router.post("/mcp", agentLimiter, authenticateAgent, asyncHandler(mcpController.handleMcpRequest));
router.get("/mcp", agentLimiter, mcpController.rejectMcpMethod);
router.delete("/mcp", agentLimiter, mcpController.rejectMcpMethod);

// ---------- people: actions, approvals, undo ----------
router.get(
  "/actions",
  authenticateUser,
  validateRequest(actionsController.listActionsQuerySchema, "query"),
  asyncHandler(actionsController.getActions)
);
router.get("/actions/stats", authenticateUser, asyncHandler(actionsController.getActionStats));
router.get("/actions/:id", authenticateUser, asyncHandler(actionsController.getActionDetail));
router.post("/actions/:id/approve", authenticateUser, authorizeRoles("admin", "manager"), asyncHandler(actionsController.approve));
router.post(
  "/actions/:id/reject",
  authenticateUser,
  authorizeRoles("admin", "manager"),
  validateRequest(actionsController.rejectActionSchema),
  asyncHandler(actionsController.reject)
);
router.post("/actions/:id/undo", authenticateUser, authorizeRoles("admin", "manager"), asyncHandler(actionsController.undo));

// ---------- people: rules ----------
router.get("/policies", authenticateUser, asyncHandler(policiesController.getPolicies));
router.get("/policies/catalog", authenticateUser, asyncHandler(policiesController.getCatalog));
router.post(
  "/policies/draft",
  authenticateUser,
  authorizeRoles("admin"),
  validateRequest(policiesController.draftPolicySchema),
  asyncHandler(policiesController.draftPolicy)
);
router.post(
  "/policies",
  authenticateUser,
  authorizeRoles("admin"),
  validateRequest(policyInputSchema),
  asyncHandler(policiesController.addPolicy)
);
router.put(
  "/policies/:id",
  authenticateUser,
  authorizeRoles("admin"),
  validateRequest(policyInputSchema),
  asyncHandler(policiesController.editPolicy)
);
router.delete("/policies/:id", authenticateUser, authorizeRoles("admin"), asyncHandler(policiesController.removePolicy));

// ---------- people: audit ----------
router.get(
  "/audit",
  authenticateUser,
  validateRequest(auditController.auditQuerySchema, "query"),
  asyncHandler(auditController.getAuditEvents)
);
router.get(
  "/audit/export",
  authenticateUser,
  authorizeRoles("admin", "auditor"),
  validateRequest(auditController.auditQuerySchema, "query"),
  asyncHandler(auditController.exportAuditCsv)
);

// ---------- people: agent keys ----------
router.get("/agents", authenticateUser, authorizeRoles("admin"), asyncHandler(agentsController.getAgents));
router.post("/agents/:id/rotate-key", authenticateUser, authorizeRoles("admin"), asyncHandler(agentsController.rotateKey));

// ---------- demo ----------
router.get("/demo/company", authenticateUser, asyncHandler(demoController.getCompanyData));
router.post("/demo/reset", demoOnly, authenticateUser, authorizeRoles("admin"), asyncHandler(demoController.resetDemo));
router.post(
  "/demo/playground/act",
  demoOnly,
  authenticateUser,
  authorizeRoles("admin", "manager"),
  validateRequest(demoController.playgroundActionSchema),
  asyncHandler(demoController.playgroundAct)
);
router.post(
  "/demo/playground/chat",
  demoOnly,
  authenticateUser,
  authorizeRoles("admin", "manager"),
  validateRequest(demoController.playgroundChatSchema),
  asyncHandler(demoController.playgroundChat)
);

export default router;
