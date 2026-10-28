import { Request, Response } from "express";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { getRequestAgent } from "../middlewares/auth.middleware";
import { createMcpServer } from "../services/mcp/mcpServer.service";

// The MCP endpoint for AI agents (authenticated like the rest of the agent API).

// Stateless: a fresh server + transport for every request, so there are no sessions to
// keep, expire or share between server instances. Plain JSON replies (no event stream).
export async function handleMcpRequest(req: Request, res: Response) {
  const agent = getRequestAgent(res);
  const server = createMcpServer(agent);
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  res.on("close", () => {
    void transport.close();
    void server.close();
  });
  await server.connect(transport);
  await transport.handleRequest(req, res, req.body);
}

// MCP clients may try GET (a live event stream) or DELETE (end a session). We keep no
// sessions, so both are politely refused in the JSON-RPC shape MCP clients understand.
export function rejectMcpMethod(_req: Request, res: Response) {
  res.setHeader("Allow", "POST");
  return res.status(405).json({
    jsonrpc: "2.0",
    error: { code: -32000, message: "Method not allowed. Send MCP requests with POST." },
    id: null,
  });
}
