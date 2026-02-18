/**
 * DVBase MCP Server – Entry Point
 * 
 * Startet den MCP Server mit Streamable HTTP Transport.
 * 
 * Sicherheit (2 Schichten):
 * 1. Secret Path – URL ist nicht erratbar (/mcp/<SECRET>)
 * 2. IP-Whitelist – nur Anthropic's Claude.ai IP-Ranges werden akzeptiert
 * 
 * Verbindung:
 * - Claude.ai:      https://mcp.digital-vereinfacht.de/mcp/<MCP_SECRET_PATH>
 * - Health Check:    https://mcp.digital-vereinfacht.de/health
 * 
 * Env-Variablen:
 * - MCP_SECRET_PATH:  Geheimer Pfad-Suffix (z.B. "a7xK9m3Qp2wR8zF")
 * - IP_WHITELIST_ENABLED: "true" (default) oder "false" zum Deaktivieren
 */

import express from "express";
import { randomUUID } from "crypto";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createServer, PORT } from "./server.js";

const app = express();
app.use(express.json());

// ─── Security Configuration ─────────────────────────────────────────

const MCP_SECRET_PATH = process.env.MCP_SECRET_PATH || "";
const IP_WHITELIST_ENABLED = process.env.IP_WHITELIST_ENABLED !== "false";

// Trust proxy (Coolify/Traefik setzen X-Forwarded-For)
app.set("trust proxy", true);

if (!MCP_SECRET_PATH) {
  console.error(`
  ❌ FEHLER: MCP_SECRET_PATH ist nicht gesetzt!
  Der Server startet NICHT ohne Secret Path.
  Setze MCP_SECRET_PATH als Environment Variable (min. 16 Zeichen).
  `);
  process.exit(1);
}

if (MCP_SECRET_PATH.length < 16) {
  console.error(`
  ❌ FEHLER: MCP_SECRET_PATH ist zu kurz (${MCP_SECRET_PATH.length} Zeichen).
  Mindestens 16 Zeichen für ausreichende Sicherheit.
  `);
  process.exit(1);
}

const MCP_ROUTE = `/mcp/${MCP_SECRET_PATH}`;

// ─── IP Whitelist (Anthropic's Claude.ai Outbound IPs) ──────────────

/**
 * Anthropic publiziert feste IP-Ranges für Claude.ai MCP-Verbindungen.
 * Quelle: https://docs.anthropic.com/en/docs/build-with-claude/mcp/remote-mcp-servers
 * 
 * Primary Range: 160.79.104.0/21
 * Legacy IPs: ab 15. Jan 2026 deprecated, hier trotzdem drin als Fallback
 */
const ANTHROPIC_IP_RANGES = {
  // CIDR: 160.79.104.0 – 160.79.111.255
  primary: { network: 0xA04F6800, mask: 0xFFFFF800 }, // 160.79.104.0/21
  legacy: new Set([
    "34.162.46.92",
    "34.162.102.82",
    "34.162.136.91",
    "34.162.142.92",
    "34.162.183.95",
  ]),
};

function ipToInt(ip: string): number {
  const parts = ip.split(".").map(Number);
  return ((parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0;
}

function isAnthropicIp(ip: string): boolean {
  // IPv6-mapped IPv4 (::ffff:1.2.3.4) → extrahiere IPv4-Teil
  const cleanIp = ip.replace(/^::ffff:/, "");

  // Localhost für lokale Entwicklung
  if (cleanIp === "127.0.0.1" || cleanIp === "::1" || cleanIp === "localhost") {
    return !IP_WHITELIST_ENABLED;
  }

  // Primary CIDR check
  const ipInt = ipToInt(cleanIp);
  if ((ipInt & ANTHROPIC_IP_RANGES.primary.mask) === ANTHROPIC_IP_RANGES.primary.network) {
    return true;
  }

  // Legacy IPs
  if (ANTHROPIC_IP_RANGES.legacy.has(cleanIp)) {
    return true;
  }

  return false;
}

/**
 * IP-Whitelist Middleware – blockiert alle Requests die nicht von 
 * Anthropic's Claude.ai kommen.
 */
function ipWhitelistMiddleware(
  req: express.Request,
  res: express.Response,
  next: express.NextFunction
): void {
  if (!IP_WHITELIST_ENABLED) {
    next();
    return;
  }

  const clientIp = req.ip || req.socket.remoteAddress || "";

  if (isAnthropicIp(clientIp)) {
    next();
    return;
  }

  console.warn(`🚫 Blocked request from unauthorized IP: ${clientIp} → ${req.path}`);
  res.status(403).json({
    jsonrpc: "2.0",
    error: { code: -32001, message: "Forbidden" },
    id: null,
  });
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

      await createServer().connect(transport);
      await transport.handleRequest(req, res, req.body);

      const newSessionId = transport.sessionId;
      if (newSessionId) {
        transports.set(newSessionId, transport);
        console.log(`✅ Neue Session: ${newSessionId} (IP: ${req.ip})`);

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

// Security-Middleware + MCP Handler auf Secret Path
app.post(MCP_ROUTE, ipWhitelistMiddleware, handleMcpRequest);
app.get(MCP_ROUTE, ipWhitelistMiddleware, handleMcpRequest);
app.delete(MCP_ROUTE, ipWhitelistMiddleware, async (req, res) => {
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

// Catch-all für /mcp ohne Secret → 404 (kein Hinweis dass was existiert)
app.all("/mcp", (_req, res) => {
  res.status(404).json({ error: "Not found" });
});
app.all("/mcp/*", (_req, res) => {
  res.status(404).json({ error: "Not found" });
});

// ─── Health Check (kein Auth, keine sensitiven Infos) ────────────────

app.get("/health", (_req, res) => {
  res.json({
    status: "ok",
    server: "dvbase-mcp",
    version: "1.1.0",
    activeSessions: transports.size,
    security: {
      secretPath: true,
      ipWhitelist: IP_WHITELIST_ENABLED,
    },
  });
});

// ─── Start Server ──────────────────────────────────────────────────────

app.listen(PORT, "0.0.0.0", () => {
  console.log(`
  ╔══════════════════════════════════════════════════╗
  ║  DVBase MCP Server v1.1.0                        ║
  ║  Digital Vereinfacht GmbH                        ║
  ╠══════════════════════════════════════════════════╣
  ║  Health:       http://0.0.0.0:${PORT}/health          ║
  ║  IP-Whitelist: ${IP_WHITELIST_ENABLED ? "✅ AKTIV (Anthropic IPs only)" : "⚠️  DEAKTIVIERT"}      ║
  ║  Secret Path:  ✅ AKTIV (${MCP_SECRET_PATH.slice(0, 4)}...${MCP_SECRET_PATH.slice(-4)})            ║
  ╚══════════════════════════════════════════════════╝
  `);
});
