/**
 * DVBase MCP Server – Entry Point
 * 
 * Startet den MCP Server mit Streamable HTTP Transport.
 * Geschützt durch Bearer Token (MCP_AUTH_TOKEN in .env).
 * 
 * Verbindung:
 * - Claude.ai:      https://your-domain.de/mcp (Header: Authorization: Bearer <token>)
 * - Claude Desktop:  http://localhost:3001/mcp
 * - Health Check:    http://localhost:3001/health (kein Auth nötig)
 */

import express from "express";
import { randomUUID } from "crypto";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { server, PORT } from "./server.js";

const app = express();
app.use(express.json());

// ─── Auth Configuration ──────────────────────────────────────────────

const MCP_AUTH_TOKEN = process.env.MCP_AUTH_TOKEN || "";

if (!MCP_AUTH_TOKEN) {
  console.warn(`
  ⚠️  WARNUNG: MCP_AUTH_TOKEN ist nicht gesetzt!
  Der Server ist UNGESCHÜTZT – jeder mit der URL kann auf eure Ninox-Daten zugreifen.
  Setze MCP_AUTH_TOKEN in der .env Datei.
  `);
}

/**
 * Auth Middleware – prüft den Bearer Token.
 * Wird auf alle /mcp Endpoints angewandt.
 * /health bleibt offen (für Monitoring).
 */
function authMiddleware(
  req: express.Request,
  res: express.Response,
  next: express.NextFunction
): void {
  // Kein Token konfiguriert = Auth deaktiviert (nur für lokale Entwicklung!)
  if (!MCP_AUTH_TOKEN) {
    next();
    return;
  }

  const authHeader = req.headers.authorization;

  if (!authHeader) {
    res.status(401).json({
      jsonrpc: "2.0",
      error: { code: -32001, message: "Unauthorized: Authorization header fehlt" },
      id: null,
    });
    return;
  }

  // Akzeptiert "Bearer <token>"
  const token = authHeader.startsWith("Bearer ")
    ? authHeader.slice(7)
    : authHeader;

  if (token !== MCP_AUTH_TOKEN) {
    res.status(403).json({
      jsonrpc: "2.0",
      error: { code: -32001, message: "Forbidden: Ungültiger Token" },
      id: null,
    });
    return;
  }

  next();
}

// ─── Session Management ────────────────────────────────────────────────

const transports = new Map<string, StreamableHTTPServerTransport>();

// ─── MCP Endpoint ──────────────────────────────────────────────────────

async function handleMcpRequest(req: express.Request, res: express.Response) {
  try {
    // Check for existing session
    const sessionId = req.headers["mcp-session-id"] as string | undefined;

    if (sessionId && transports.has(sessionId)) {
      const transport = transports.get(sessionId)!;
      await transport.handleRequest(req, res, req.body);
      return;
    }

    // Check if this is an initialize request (new session)
    const body = req.body;
    const isInitialize =
      body?.method === "initialize" ||
      (Array.isArray(body) &&
        body.some(
          (msg: Record<string, unknown>) => msg.method === "initialize"
        ));

    if (isInitialize && req.method === "POST") {
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
      });

      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);

      const newSessionId = transport.sessionId;
      if (newSessionId) {
        transports.set(newSessionId, transport);
        console.log(`✅ Neue Session: ${newSessionId}`);

        transport.onclose = () => {
          transports.delete(newSessionId);
          console.log(`❌ Session beendet: ${newSessionId}`);
        };
      }

      return;
    }

    res.status(400).json({
      jsonrpc: "2.0",
      error: {
        code: -32000,
        message: "No valid session. Send an initialize request first.",
      },
      id: body?.id || null,
    });
  } catch (error) {
    console.error("Error handling MCP request:", error);
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: "2.0",
        error: { code: -32603, message: "Internal server error" },
        id: null,
      });
    }
  }
}

// Auth auf alle /mcp Routen anwenden
app.post("/mcp", authMiddleware, handleMcpRequest);
app.get("/mcp", authMiddleware, handleMcpRequest);
app.delete("/mcp", authMiddleware, async (req, res) => {
  const sessionId = req.headers["mcp-session-id"] as string | undefined;
  if (sessionId && transports.has(sessionId)) {
    const transport = transports.get(sessionId)!;
    await transport.handleRequest(req, res);
    transports.delete(sessionId);
    console.log(`🗑️ Session gelöscht: ${sessionId}`);
  } else {
    res.status(400).json({ error: "Invalid or missing session ID" });
  }
});

// ─── Health Check (kein Auth) ─────────────────────────────────────────

app.get("/health", (_req, res) => {
  res.json({
    status: "ok",
    server: "dvbase-mcp",
    version: "1.0.0",
    activeSessions: transports.size,
    authEnabled: !!MCP_AUTH_TOKEN,
  });
});

// ─── Start Server ──────────────────────────────────────────────────────

app.listen(PORT, "0.0.0.0", () => {
  console.log(`
  ╔══════════════════════════════════════════════╗
  ║  DVBase MCP Server v1.0.0                    ║
  ║  Digital Vereinfacht GmbH                    ║
  ╠══════════════════════════════════════════════╣
  ║  MCP:    http://0.0.0.0:${PORT}/mcp${" ".repeat(22 - String(PORT).length)}║
  ║  Health: http://0.0.0.0:${PORT}/health${" ".repeat(19 - String(PORT).length)}║
  ║  Auth:   ${MCP_AUTH_TOKEN ? "✅ AKTIV" : "⚠️  DEAKTIVIERT"}${" ".repeat(MCP_AUTH_TOKEN ? 28 : 24)}║
  ╚══════════════════════════════════════════════╝
  `);
});
