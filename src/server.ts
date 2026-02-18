/**
 * DVBase MCP Server
 * 
 * Ein MCP Server für Digital Vereinfacht, der Claude direkten Zugriff
 * auf das Ninox-Datenmodell und Entwickler-Kontextwissen gibt.
 * 
 * Tools:
 * - list_modules: Zeigt alle verfügbaren DVBase Module
 * - get_schema: Holt das Schema (Tabellen, Felder, Formeln) für ein Modul
 * - get_context: Holt Entwickler-Kontextwissen (Prozesse, Stolperfallen, n8n-Deps)
 * - get_full_module_info: Kombiniert Schema + Kontext für ein Modul (empfohlen für Debugging)
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { NinoxClient, NinoxTableSchema, NinoxFullTableSchema, NinoxFullField } from "./ninox-client.js";
import { ContextStore, ModuleContext } from "./context-store.js";

// ─── Configuration ─────────────────────────────────────────────────────

const NINOX_API_KEY = process.env.NINOX_API_KEY || "";
const NINOX_TEAM_ID = process.env.NINOX_TEAM_ID || "";
const NINOX_DATABASE_ID = process.env.NINOX_DATABASE_ID || "";
const NINOX_BASE_URL = process.env.NINOX_BASE_URL || ""; // Private Cloud: https://digital-vereinfacht.ninoxdb.de/v1
const DOKU_TABLE_ID = process.env.DOKU_TABLE_ID || "";
const PORT = parseInt(process.env.PORT || "3001", 10);

if (!NINOX_API_KEY || !NINOX_TEAM_ID || !NINOX_DATABASE_ID) {
  console.error(
    "Missing required environment variables: NINOX_API_KEY, NINOX_TEAM_ID, NINOX_DATABASE_ID"
  );
  process.exit(1);
}

// ─── Initialize Clients ────────────────────────────────────────────────

const ninoxClient = new NinoxClient({
  apiKey: NINOX_API_KEY,
  teamId: NINOX_TEAM_ID,
  databaseId: NINOX_DATABASE_ID,
  ...(NINOX_BASE_URL && { baseUrl: NINOX_BASE_URL }),
});

const contextStore = DOKU_TABLE_ID
  ? new ContextStore(ninoxClient, DOKU_TABLE_ID)
  : null;

// ─── MCP Server Factory ────────────────────────────────────────────────
// Jede Session bekommt eine eigene McpServer-Instanz,
// weil das MCP SDK nur eine Transport-Verbindung pro Server erlaubt.

function createServer(): McpServer {
  const server = new McpServer({
    name: "dvbase",
    version: "1.0.0",
  });

  registerTools(server);
  return server;
}

function registerTools(server: McpServer): void {

// ─── Helper: Format Full Schema as Markdown ─────────────────────────

function formatFullSchemaAsMarkdown(schema: NinoxFullTableSchema): string {
  let md = `## Tabelle: ${schema.caption} (ID: ${schema.id})\n\n`;

  const fields = schema.fields;
  if (!fields || Object.keys(fields).length === 0) {
    md += `_Keine Felder definiert._\n\n`;
    return md;
  }

  // Sort fields by order
  const sortedFields = Object.entries(fields)
    .sort(([, a], [, b]) => (a.order ?? 999) - (b.order ?? 999));

  md += `### Felder (${sortedFields.length})\n\n`;

  for (const [fieldId, field] of sortedFields) {
    const fieldType = field.base || "unknown";
    md += `#### ${field.caption} (ID: \`${fieldId}\`, Typ: \`${fieldType}\`)\n`;

    // Formel (für fn-Felder)
    if (field.fn) {
      md += `- **Formel/Code:**\n\`\`\`\n${field.fn}\n\`\`\`\n`;
    }

    // Sichtbarkeitsbedingung ("Feld nur anzeigen wenn")
    if (field.visibility) {
      md += `- **Nur anzeigen wenn:** Feld \`${field.visibility}\` truthy\n`;
    }

    // Choice/Multi-Optionen (values Objekt)
    if (field.values && typeof field.values === "object") {
      const options = Object.entries(field.values)
        .sort(([, a], [, b]) => ((a as any).order ?? 0) - ((b as any).order ?? 0))
        .map(([id, v]) => {
          let opt = v.caption || id;
          if (v.icon?.icon) opt += ` (${v.icon.icon})`;
          return opt;
        });
      md += `- **Optionen:** ${options.join(", ")}\n`;
    }

    // Referenz auf andere Tabelle
    if (field.ref) {
      md += `- **Verknüpft mit Tabelle:** \`${field.ref}\`\n`;
    }

    // Reverse-Verknüpfung
    if (field.base === "rev" && field.reverseField) {
      md += `- **Rück-Verknüpfung von Feld:** \`${field.reverseField}\`\n`;
    }

    // Required
    if (field.required) {
      md += `- **Pflichtfeld:** ja\n`;
    }

    // Style
    if (field.style) {
      md += `- **Style:** \`${field.style}\`\n`;
    }

    // Label-Position
    if (field.labelPosition) {
      md += `- **Label-Position:** ${field.labelPosition}\n`;
    }

    // Alle weiteren relevanten Properties
    const knownKeys = new Set([
      "base", "caption", "captions", "fn", "values",
      "visibility", "ref", "reverseField", "required",
      "style", "labelPosition",
      // Meta/Layout – weniger relevant
      "order", "width", "formWidth", "height", "uuid",
      "globalSearch", "hasIndex", "tooltips", "nextChoiceId",
      "multiRenderer", "choiceRenderer"
    ]);
    const extraProps: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(field)) {
      if (!knownKeys.has(key) && value !== undefined && value !== null && value !== "" && value !== false) {
        extraProps[key] = value;
      }
    }
    if (Object.keys(extraProps).length > 0) {
      md += `- **Weitere:** \`${JSON.stringify(extraProps)}\`\n`;
    }

    md += `\n`;
  }

  md += `_Feld-IDs sind stabil und ändern sich nie._\n\n`;
  return md;
}

// Legacy-Formatierung für /tables Fallback
function formatSchemaAsMarkdown(schema: NinoxTableSchema): string {
  let md = `## Tabelle: ${schema.name} (ID: ${schema.id})\n\n`;
  if (schema.fields && schema.fields.length > 0) {
    md += `### Felder\n\n`;
    for (const field of schema.fields) {
      md += `- **${field.name}** (ID: \`${field.id}\`, Typ: \`${field.type}\`)\n`;
    }
    md += "\n";
  }
  return md;
}

function formatContextAsMarkdown(context: ModuleContext): string {
  let md = `## Kontextwissen: ${context.moduleName}\n\n`;

  if (context.processDescription) {
    md += `### Prozessbeschreibung\n${context.processDescription}\n\n`;
  }
  if (context.knownIssues) {
    md += `### Bekannte Stolperfallen\n${context.knownIssues}\n\n`;
  }
  if (context.n8nDependencies) {
    md += `### n8n-Abhängigkeiten\n${context.n8nDependencies}\n\n`;
  }
  if (context.customerSpecific) {
    md += `### Kundenspezifische Anpassungen\n${context.customerSpecific}\n\n`;
  }

  return md;
}

// ─── Tool: list_modules ────────────────────────────────────────────────

server.tool(
  "list_modules",
  "Listet alle verfügbaren DVBase Module auf. Nutze dies als Einstieg um zu verstehen welche Module existieren.",
  {},
  async () => {
    try {
      let text = `# DVBase Module & Tabellen\n\n`;

      // Try full schema first (shows all tables including hidden ones)
      try {
        const fullSchema = await ninoxClient.getFullDatabaseSchema();
        const types = fullSchema.types || {};
        const sortedTables = Object.entries(types).sort(([, a], [, b]) =>
          a.caption.localeCompare(b.caption)
        );

        text += `Verfügbare Tabellen (${sortedTables.length}):\n\n`;
        for (const [tableId, table] of sortedTables) {
          const fieldCount = Object.keys(table.fields || {}).length;
          const formulaCount = Object.values(table.fields || {}).filter(f => f.base === "fn").length;
          const hidden = table.hidden ? " 🔒" : "";
          const icon = table.icon ? ` (${table.icon})` : "";
          let info = `${fieldCount} Felder`;
          if (formulaCount > 0) info += `, ${formulaCount} Formeln`;
          text += `- **${table.caption}**${icon}${hidden} (ID: \`${tableId}\`, ${info})\n`;
        }
      } catch {
        // Fallback to /tables endpoint
        const tables = await ninoxClient.listTables();
        text += `Verfügbare Tabellen (${tables.length}):\n\n`;
        for (const table of tables) {
          text += `- **${table.name}** (ID: \`${table.id}\`, ${table.fields?.length || 0} Felder)\n`;
        }
        text += `\n_⚠️ Fallback-Modus: Keine Formelfelder sichtbar._\n`;
      }

      // If context store is available, also list documented modules
      if (contextStore) {
        const documentedModules = await contextStore.listModules();
        if (documentedModules.length > 0) {
          text += `\n## Dokumentierte Module (mit Kontextwissen)\n\n`;
          for (const mod of documentedModules) {
            text += `- ${mod}\n`;
          }
          text += `\n_Nutze get_full_module_info für Schema + Kontextwissen zu einem Modul._\n`;
        }
      }

      return {
        content: [{ type: "text", text }],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Fehler beim Abrufen der Module: ${error instanceof Error ? error.message : String(error)}`,
          },
        ],
        isError: true,
      };
    }
  }
);

// ─── Tool: get_schema ──────────────────────────────────────────────────

server.tool(
  "get_schema",
  "Holt das VOLLSTÄNDIGE Ninox-Schema für eine Tabelle: Felder, Feldtypen, Formeln, Buttons, Sichtbarkeitsbedingungen, Verknüpfungen. Nutze list_modules um die verfügbaren Tabellen-IDs zu sehen.",
  {
    tableId: z
      .string()
      .describe(
        "Die Ninox Tabellen-ID. Nutze list_modules um verfügbare IDs zu sehen."
      ),
  },
  async ({ tableId }) => {
    try {
      // Try full schema first (includes formulas, buttons, visibility)
      const fullSchema = await ninoxClient.getFullTableSchema(tableId);
      if (fullSchema) {
        const markdown = formatFullSchemaAsMarkdown(fullSchema);
        return {
          content: [{ type: "text", text: markdown }],
        };
      }

      // Fallback to /tables endpoint
      const schema = await ninoxClient.getTableSchema(tableId);
      const markdown = formatSchemaAsMarkdown(schema);
      return {
        content: [{ type: "text", text: markdown + "\n_⚠️ Fallback: Nur Datenfelder, keine Formeln/Buttons._\n" }],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Fehler beim Abrufen des Schemas für Tabelle "${tableId}": ${error instanceof Error ? error.message : String(error)}`,
          },
        ],
        isError: true,
      };
    }
  }
);

// ─── Tool: get_context ─────────────────────────────────────────────────

server.tool(
  "get_context",
  "Holt Entwickler-Kontextwissen für ein DVBase Modul: Prozessbeschreibung, bekannte Stolperfallen, n8n-Abhängigkeiten, kundenspezifische Anpassungen.",
  {
    moduleName: z
      .string()
      .describe(
        'Name des Moduls, z.B. "Bautagesbericht", "Faktura", "DATEV-Export"'
      ),
  },
  async ({ moduleName }) => {
    if (!contextStore) {
      return {
        content: [
          {
            type: "text",
            text: "Kontextwissen nicht verfügbar: DOKU_TABLE_ID ist nicht konfiguriert. Bitte die Dokumentations-Tabelle in Ninox anlegen und die Table-ID in der .env setzen.",
          },
        ],
        isError: true,
      };
    }

    try {
      const context = await contextStore.getModuleContext(moduleName);

      if (!context) {
        return {
          content: [
            {
              type: "text",
              text: `Kein Kontextwissen für Modul "${moduleName}" gefunden. Verfügbare Module mit get_context: ${(await contextStore.listModules()).join(", ") || "keine dokumentiert"}`,
            },
          ],
        };
      }

      return {
        content: [{ type: "text", text: formatContextAsMarkdown(context) }],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Fehler beim Abrufen des Kontextwissens: ${error instanceof Error ? error.message : String(error)}`,
          },
        ],
        isError: true,
      };
    }
  }
);

// ─── Tool: get_full_module_info ────────────────────────────────────────

server.tool(
  "get_full_module_info",
  "Kombiniert Schema + Kontextwissen für ein DVBase Modul. EMPFOHLEN für Bug-Debugging: Gibt dir alle Tabellen mit Feldern, Formeln UND Prozesswissen, Stolperfallen, n8n-Abhängigkeiten.",
  {
    moduleName: z
      .string()
      .describe(
        'Name des Moduls, z.B. "Bautagesbericht", "Faktura", "DATEV-Export"'
      ),
  },
  async ({ moduleName }) => {
    try {
      let fullText = `# DVBase Modul: ${moduleName}\n\n`;

      // 1. Get context to find related table IDs
      let relatedTableIds: string[] = [];
      if (contextStore) {
        const context = await contextStore.getModuleContext(moduleName);
        if (context) {
          fullText += formatContextAsMarkdown(context);
          relatedTableIds = context.relatedTableIds;
        } else {
          fullText += `_Kein Kontextwissen für "${moduleName}" dokumentiert._\n\n`;
        }
      }

      // 2. Get schemas for related tables (full schema with formulas!)
      if (relatedTableIds.length > 0) {
        fullText += `---\n\n# Schema\n\n`;
        for (const tableId of relatedTableIds) {
          try {
            const fullSchema = await ninoxClient.getFullTableSchema(tableId);
            if (fullSchema) {
              fullText += formatFullSchemaAsMarkdown(fullSchema);
            } else {
              // Fallback
              const schema = await ninoxClient.getTableSchema(tableId);
              fullText += formatSchemaAsMarkdown(schema);
            }
          } catch (err) {
            fullText += `_Fehler beim Laden von Tabelle ${tableId}: ${err instanceof Error ? err.message : String(err)}_\n\n`;
          }
        }
      } else {
        // Fallback: try to find tables by name matching against full schema
        try {
          const fullDbSchema = await ninoxClient.getFullDatabaseSchema();
          const matchingTables = Object.entries(fullDbSchema.types || {}).filter(
            ([, t]) =>
              t.caption.toLowerCase().includes(moduleName.toLowerCase()) ||
              moduleName.toLowerCase().includes(t.caption.toLowerCase())
          );

          if (matchingTables.length > 0) {
            fullText += `---\n\n# Schema (automatisch gefunden via Name-Matching)\n\n`;
            for (const [tableId, table] of matchingTables) {
              fullText += formatFullSchemaAsMarkdown({ id: tableId, ...table });
            }
          } else {
            fullText += `_Keine passenden Tabellen gefunden. Nutze list_modules für eine Übersicht und get_schema für einzelne Tabellen._\n`;
          }
        } catch (err) {
          // Final fallback to /tables
          const allTables = await ninoxClient.listTables();
          const matchingTables = allTables.filter(
            (t) =>
              t.name.toLowerCase().includes(moduleName.toLowerCase()) ||
              moduleName.toLowerCase().includes(t.name.toLowerCase())
          );

          if (matchingTables.length > 0) {
            fullText += `---\n\n# Schema (Fallback - ohne Formeln)\n\n`;
            for (const table of matchingTables) {
              try {
                const schema = await ninoxClient.getTableSchema(table.id);
                fullText += formatSchemaAsMarkdown(schema);
              } catch (e) {
                fullText += `_Fehler beim Laden von Tabelle ${table.id}_\n\n`;
              }
            }
          } else {
            fullText += `_Keine passenden Tabellen gefunden._\n`;
          }
        }
      }

      return {
        content: [{ type: "text", text: fullText }],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Fehler: ${error instanceof Error ? error.message : String(error)}`,
          },
        ],
        isError: true,
      };
    }
  }
);

// ─── Tool: query_data ────────────────────────────────────────────────

server.tool(
  "query_data",
  "Führt eine Ninox-Script-Abfrage gegen die DVBase-Datenbank aus (nur lesend). Sehr mächtig – kann beliebige Daten abfragen, filtern, aggregieren. Beispiele: '(select Rechnungen where Status = \"Offen\")' oder 'cnt(select Bautagesberichte)' oder '(select Mitarbeiter).\"Name\"'",
  {
    query: z
      .string()
      .describe(
        'Ninox-Script Abfrage. Beispiele: (select Tabelle)."Feldname", cnt(select Tabelle where Feld = "Wert"), sum((select Tabelle)."Betrag")'
      ),
  },
  async ({ query }) => {
    try {
      const result = await ninoxClient.executeQuery(query);
      const formatted = JSON.stringify(result, null, 2);

      return {
        content: [
          {
            type: "text",
            text: `# Query-Ergebnis\n\n**Query:** \`${query}\`\n\n\`\`\`json\n${formatted}\n\`\`\``,
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Fehler bei Query "${query}": ${error instanceof Error ? error.message : String(error)}`,
          },
        ],
        isError: true,
      };
    }
  }
);

} // end registerTools

// ─── Export factory for transport setup ──────────────────────────────────

export { createServer, PORT };
