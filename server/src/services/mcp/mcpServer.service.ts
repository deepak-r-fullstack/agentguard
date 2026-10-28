import { Types } from "mongoose";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { CallToolResult, ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";
import { AppError, ForbiddenError, NotFoundError } from "../../helpers/errors";
import { AgentDoc } from "../../models/agent.model";
import { logger, serializeError } from "../../utils/logger";
import { ActionDefinition, listActionDefinitions } from "../actions/actionRegistry";
import { describeForAgent, getAction, requestAction } from "../actions/guard.service";

// ---------------------------------------------------------------------------
// MCP (Model Context Protocol) front door for AI agents.
// Every registered action becomes one tool. A tool call does NOT run anything
// itself: it goes through guard.service requestAction(), exactly like
// POST /api/agent/actions, so policy checks, approvals, audit and undo all apply.
// A new McpServer is built for every request (stateless), already bound to the
// calling agent, so one agent can never act as another.
// ---------------------------------------------------------------------------

type AgentIdentity = Pick<AgentDoc, "_id" | "workspaceId" | "name">;

const GET_ACTION_STATUS_TOOL = "get_action_status";

// Same rules as the REST API, so both doors accept exactly the same requests.
const commonInput = {
  onBehalfOf: z.string().trim().min(1).max(200).describe("The person you are working for, e.g. their email address."),
  idempotencyKey: z
    .string()
    .trim()
    .min(8)
    .max(100)
    .describe("A unique id for this request (8-100 characters). Send the same id when you retry, so it only happens once."),
  reason: z.string().trim().max(500).optional().describe("Why you are doing this, in plain words."),
};

// Tool shapes are built from the registry at runtime, which the SDK's own generic registerTool()
// typing cannot follow (TypeScript gives up: "type instantiation is excessively deep"). This
// is the same call, typed for exactly what we pass. The SDK still validates every input at runtime.
type RegisterTool = (
  name: string,
  config: { title: string; description: string; inputSchema: z.ZodTypeAny; annotations: ToolAnnotations },
  handler: (args: Record<string, unknown>) => Promise<CallToolResult>
) => unknown;

function registerTool(server: McpServer, ...args: Parameters<RegisterTool>) {
  (server.registerTool as unknown as RegisterTool).call(server, ...args);
}

interface ActionToolArgs extends Record<string, unknown> {
  onBehalfOf: string;
  idempotencyKey: string;
  reason?: string;
}

// "booking.cancel" -> "booking_cancel" (some MCP clients do not allow dots in tool names).
export function toToolName(actionKey: string): string {
  return actionKey.replace(/\./g, "_");
}

function jsonResult(payload: unknown): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(payload) }] };
}

// Agents only ever see our own (safe, written-by-us) messages. Anything else could leak internals.
function errorResult(err: unknown, toolName: string): CallToolResult {
  if (!(err instanceof AppError)) {
    logger.error("mcp tool call failed", { tool: toolName, ...serializeError(err) });
  }
  const message = err instanceof AppError ? err.message : "The action failed because of an unexpected error.";
  return { isError: true, content: [{ type: "text", text: message }] };
}

// The MCP reply should point agents at the MCP way of checking later, not the REST address.
async function toMcpResponse(record: Parameters<typeof describeForAgent>[0]) {
  const response = await describeForAgent(record);
  if (response.status !== "pending_approval") return response;
  return { ...response, message: `Waiting for a person to approve. Check again later with the ${GET_ACTION_STATUS_TOOL} tool.` };
}

function describeTool(definition: ActionDefinition): string {
  return definition.irreversible
    ? `${definition.description} This cannot be undone, so a person always has to approve it.`
    : definition.description;
}

function registerActionTool(server: McpServer, agent: AgentIdentity, definition: ActionDefinition) {
  const toolName = toToolName(definition.key);
  // Every action's params are a plain z.object, so its shape can sit next to the common fields.
  const paramsShape: z.ZodRawShape = definition.paramsSchema instanceof z.ZodObject ? definition.paramsSchema.shape : {};
  // Strict, like the REST API: a field the action does not define is refused, not silently dropped.
  const inputSchema = z.object({ ...paramsShape, ...commonInput }).strict();

  // The SDK has already checked args against inputSchema, so the common fields are present.
  const handler = async (args: Record<string, unknown>): Promise<CallToolResult> => {
    try {
      const { onBehalfOf, idempotencyKey, reason, ...params } = args as ActionToolArgs;
      const record = await requestAction(agent, { action: definition.key, params, reason, onBehalfOf, idempotencyKey });
      return jsonResult(await toMcpResponse(record));
    } catch (err) {
      return errorResult(err, toolName);
    }
  };

  registerTool(
    server,
    toolName,
    {
      title: definition.label,
      description: describeTool(definition),
      inputSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: definition.irreversible,
        // The same idempotencyKey always returns the first result and never acts twice.
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    handler
  );
}

const statusInput = z
  .object({ actionId: z.string().trim().min(1).max(100).describe("The actionId returned when you asked for the action.") })
  .strict();

function registerStatusTool(server: McpServer, agent: AgentIdentity) {
  registerTool(
    server,
    GET_ACTION_STATUS_TOOL,
    {
      title: "Check an action's status",
      description: "Checks what happened to an action you asked for earlier, for example one that was waiting for a person to approve.",
      inputSchema: statusInput,
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    async ({ actionId }: Record<string, unknown>): Promise<CallToolResult> => {
      try {
        if (typeof actionId !== "string") throw new NotFoundError("That action was not found.");
        if (!Types.ObjectId.isValid(actionId)) throw new NotFoundError("That action was not found.");
        const record = await getAction(agent.workspaceId as Types.ObjectId, actionId);
        // Agents can only read their own actions (same rule as GET /api/agent/actions/:id).
        if (String(record.agentId) !== String(agent._id)) throw new ForbiddenError();
        return jsonResult(await toMcpResponse(record));
      } catch (err) {
        return errorResult(err, GET_ACTION_STATUS_TOOL);
      }
    }
  );
}

export function createMcpServer(agent: AgentIdentity): McpServer {
  const server = new McpServer(
    { name: "agentguard", version: "1.0.0" },
    {
      instructions:
        "AgentGuard checks every action against company rules. Some actions run straight away, some wait for a person to approve, and some are refused. " +
        `If an action is waiting, use ${GET_ACTION_STATUS_TOOL} later. If it is refused, do not retry; tell the person why.`,
    }
  );
  for (const definition of listActionDefinitions()) registerActionTool(server, agent, definition);
  registerStatusTool(server, agent);
  return server;
}
