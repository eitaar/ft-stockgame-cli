import type { Context } from 'hono';
import { streamSSE } from 'hono/streaming';
import { findTool, tools, type ToolContext } from './tools.js';

export const PROTOCOL_VERSION = '2025-03-26';
export const SERVER_INFO = { name: 'ft-stockgame', version: '2.0.0' };

export const SESSION_HEADER = 'Mcp-Session-Id';

interface JsonRpcMessage {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: Record<string, any>;
  result?: unknown;
  error?: unknown;
}

interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: string | number | null;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

const JSON_HEADERS = { 'content-type': 'application/json' };

function rpcError(id: string | number | null, code: number, message: string, data?: unknown): JsonRpcResponse {
  return { jsonrpc: '2.0', id, error: { code, message, ...(data !== undefined ? { data } : {}) } };
}

function isRequest(msg: JsonRpcMessage): boolean {
  return typeof msg.method === 'string' && msg.id !== undefined && msg.id !== null;
}

/**
 * MCP Streamable HTTP transport (spec 2025-03-26), implemented against Web-standard
 * Request/Response so it runs on Node, Bun and Deno through Hono.
 */
export class McpEndpoint {
  #ctx: ToolContext;
  #sessions = new Map<string, { createdAt: number; initialized: boolean }>();

  constructor(ctx: ToolContext) {
    this.#ctx = ctx;
  }

  async #dispatch(msg: JsonRpcMessage, sessionId: string | null): Promise<JsonRpcResponse | null> {
    const id = msg.id ?? null;
    switch (msg.method) {
      case 'initialize': {
        const session = sessionId && this.#sessions.get(sessionId);
        if (session) session.initialized = true;
        return {
          jsonrpc: '2.0',
          id,
          result: {
            protocolVersion: PROTOCOL_VERSION,
            capabilities: { tools: { listChanged: false } },
            serverInfo: SERVER_INFO,
            instructions:
              'Unofficial FT Stock Picking Game tools. Read tools are safe; write tools change real game state.',
          },
        };
      }
      case 'ping':
        return { jsonrpc: '2.0', id, result: {} };
      case 'tools/list':
        return {
          jsonrpc: '2.0',
          id,
          result: {
            tools: tools.map((t) => ({
              name: t.name,
              description: t.description,
              inputSchema: t.inputSchema,
            })),
          },
        };
      case 'tools/call': {
        const name = msg.params?.name as string | undefined;
        const args = (msg.params?.arguments ?? {}) as Record<string, any>;
        const tool = name ? findTool(name) : undefined;
        if (!tool) return rpcError(id, -32602, `unknown tool: ${name ?? '(none)'}`);
        try {
          const value = await tool.handler(this.#ctx, args);
          return {
            jsonrpc: '2.0',
            id,
            result: { content: [{ type: 'text', text: JSON.stringify(value, null, 2) }] },
          };
        } catch (err) {
          const message = (err as Error).message ?? String(err);
          return {
            jsonrpc: '2.0',
            id,
            result: { content: [{ type: 'text', text: `error: ${message}` }], isError: true },
          };
        }
      }
      default:
        return rpcError(id, -32601, `method not found: ${msg.method ?? '(none)'}`);
    }
  }

  /** POST /mcp — JSON-RPC over HTTP. */
  async post(c: Context): Promise<Response> {
    const raw = await c.req.text();
    let parsed: JsonRpcMessage | JsonRpcMessage[];
    try {
      parsed = JSON.parse(raw);
    } catch {
      return new Response(JSON.stringify(rpcError(null, -32700, 'parse error')), {
        status: 400,
        headers: JSON_HEADERS,
      });
    }

    const messages = Array.isArray(parsed) ? parsed : [parsed];
    const incomingSession = c.req.header(SESSION_HEADER);
    let sessionId = incomingSession ?? null;
    const fresh = !sessionId;

    const responses: JsonRpcResponse[] = [];
    for (const msg of messages) {
      if (!isRequest(msg)) continue; // notifications/responses get no reply
      const res = await this.#dispatch(msg, sessionId);
      if (res) responses.push(res);
    }

    // A new session id is minted for the first request that isn't already in a session.
    if (fresh && messages.some((m) => m.method === 'initialize')) {
      sessionId = crypto.randomUUID();
      this.#sessions.set(sessionId, { createdAt: Date.now(), initialized: true });
    }

    const headers: Record<string, string> = { ...JSON_HEADERS };
    if (sessionId && !incomingSession) headers[SESSION_HEADER] = sessionId;

    // Only notifications/responses -> 202 Accepted, no body.
    if (responses.length === 0) return new Response(null, { status: 202, headers });

    const body = Array.isArray(parsed) ? responses : responses[0];
    return new Response(JSON.stringify(body), { status: 200, headers });
  }

  /** GET /mcp — optional server -> client SSE stream. */
  get(c: Context): Response | Promise<Response> {
    return streamSSE(c, async (stream) => {
      try {
        while (true) {
          await stream.writeSSE({ event: 'ping', data: 'keep-alive' });
          await stream.sleep(15000);
        }
      } catch {
        /* client disconnected */
      }
    });
  }

  /** DELETE /mcp — end a session. */
  delete(c: Context): Response {
    const sessionId = c.req.header(SESSION_HEADER);
    if (sessionId) this.#sessions.delete(sessionId);
    return new Response(null, { status: 204 });
  }
}
