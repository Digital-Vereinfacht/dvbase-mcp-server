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
import { NinoxClient, NinoxTableSchema } from "./ninox-client.js";
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

// ─── Helper: Format Schema as Markdown ─────────────────────────────────

function formatSchemaAsMarkdown(schema: NinoxTableSchema): string {
  let md = `## Tabelle: ${schema.name} (ID: ${schema.id})\n\n`;

  if (schema.fields && schema.fields.length > 0) {
    md += `### Felder\n\n`;

    for (const field of schema.fields) {
      // Ninox verwendet "caption" für den Namen und "base" für den Typ
      const fieldName = field.name || field.caption || field.id;
      const fieldType = field.type || field.base || "unknown";

      md += `#### ${fieldName} (ID: \`${field.id}\`, Typ: \`${fieldType}\`)\n`;

      // Formelfelder (Ninox: "fn")
      if (field.fn) {
        md += `- **Formel:** \`\`\`\n${field.fn}\n\`\`\`\n`;
      }

      // Choice/Multi-Optionen (Ninox: "values" Objekt)
      if (field.values && typeof field.values === "object") {
        const values = field.values as Record<string, { caption?: string; color?: string; icon?: { icon?: string } }>;
        const options = Object.entries(values)
          .sort((a, b) => ((a[1] as any).order ?? 0) - ((b[1] as any).order ?? 0))
          .map(([id, v]) => {
            let opt = `${v.caption || id}`;
            if (v.icon?.icon) opt += ` (${v.icon.icon})`;
            return opt;
          });
        md += `- **Optionen:** ${options.join(", ")}\n`;
      }

      // Legacy choices Array (falls doch vorhanden)
      if (field.choices && Array.isArray(field.choices)) {
        md += `- **Optionen:** ${field.choices.map((c: any) => c.caption).join(", ")}\n`;
      }

      // Sichtbarkeitsbedingung
      if (field.displayIf) {
        md += `- **Nur anzeigen wenn:** \`${field.displayIf}\`\n`;
      }
      if (field.visibleIf) {
        md += `- **Nur anzeigen wenn:** \`${field.visibleIf}\`\n`;
      }
      if (field.hideIf) {
        md += `- **Ausblenden wenn:** \`${field.hideIf}\`\n`;
      }

      // Trigger/Events
      if (field.onOpen) {
        md += `- **Bei Öffnen:** \`\`\`\n${field.onOpen}\n\`\`\`\n`;
      }
      if (field.afterUpdate) {
        md += `- **Nach Änderung:** \`\`\`\n${field.afterUpdate}\n\`\`\`\n`;
      }
      if (field.onChange) {
        md += `- **Bei Änderung:** \`\`\`\n${field.onChange}\n\`\`\`\n`;
      }

      // Required / Pflichtfeld
      if (field.required) {
        md += `- **Pflichtfeld:** ja\n`;
      }

      // Referenz auf andere Tabelle
      if (field.ref) {
        md += `- **Verknüpft mit Tabelle:** \`${field.ref}\`\n`;
      }
      if (field.referencedTable) {
        md += `- **Verknüpft mit Tabelle:** \`${field.referencedTable}\`\n`;
      }

      // Label-Position (z.B. "none" = Überschrift/Layout-Feld)
      if (field.labelPosition) {
        md += `- **Label-Position:** ${field.labelPosition}\n`;
      }

      // Styling
      if (field.style) {
        md += `- **Style:** \`${field.style}\`\n`;
      }

      // Alle weiteren Properties die wir nicht explizit behandeln
      const knownKeys = new Set([
        "id", "name", "type", "base", "caption", "captions", "fn",
        "values", "choices", "displayIf", "visibleIf", "hideIf",
        "onOpen", "afterUpdate", "onChange", "required", "ref",
        "referencedTable", "labelPosition", "style",
        // Layout/Meta - weniger relevant für Debugging
        "order", "width", "formWidth", "height", "uuid",
        "globalSearch", "hasIndex", "tooltips", "nextChoiceId",
        "multiRenderer"
      ]);
      const extraProps: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(field)) {
        if (!knownKeys.has(key) && value !== undefined && value !== null && value !== "" && value !== false) {
          extraProps[key] = value;
        }
      }
      if (Object.keys(extraProps).length > 0) {
        md += `- **Weitere Eigenschaften:** \`${JSON.stringify(extraProps)}\`\n`;
      }

      md += `\n`;
    }

    md += `_Feld-IDs (${schema.fields.map(f => f.id).join(", ")}) sind stabil und ändern sich nie._\n\n`;
  } else {
    md += `_Keine Felder definiert._\n\n`;
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
      // Get tables from Ninox
      const tables = await ninoxClient.listTables();
      let text = `# DVBase Module & Tabellen\n\n`;
      text += `Verfügbare Tabellen in der Datenbank:\n\n`;
      
      for (const table of tables) {
        text += `- **${table.name}** (ID: \`${table.id}\`, ${table.fields?.length || 0} Felder)\n`;
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
  "Holt das Ninox-Schema für eine bestimmte Tabelle: Felder, Feldtypen, Formeln, Verknüpfungen. Nutze list_modules um die verfügbaren Tabellen-IDs zu sehen.",
  {
    tableId: z
      .string()
      .describe(
        "Die Ninox Tabellen-ID. Nutze list_modules um verfügbare IDs zu sehen."
      ),
  },
  async ({ tableId }) => {
    try {
      const schema = await ninoxClient.getTableSchema(tableId);
      const markdown = formatSchemaAsMarkdown(schema);

      return {
        content: [{ type: "text", text: markdown }],
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

      // 2. Get schemas for related tables
      if (relatedTableIds.length > 0) {
        fullText += `---\n\n# Schema\n\n`;
        for (const tableId of relatedTableIds) {
          try {
            const schema = await ninoxClient.getTableSchema(tableId);
            fullText += formatSchemaAsMarkdown(schema);
          } catch (err) {
            fullText += `_Fehler beim Laden von Tabelle ${tableId}: ${err instanceof Error ? err.message : String(err)}_\n\n`;
          }
        }
      } else {
        // Fallback: try to find tables by name matching
        const allTables = await ninoxClient.listTables();
        const matchingTables = allTables.filter(
          (t) =>
            t.name.toLowerCase().includes(moduleName.toLowerCase()) ||
            moduleName.toLowerCase().includes(t.name.toLowerCase())
        );

        if (matchingTables.length > 0) {
          fullText += `---\n\n# Schema (automatisch gefunden via Name-Matching)\n\n`;
          for (const table of matchingTables) {
            try {
              const schema = await ninoxClient.getTableSchema(table.id);
              fullText += formatSchemaAsMarkdown(schema);
            } catch (err) {
              fullText += `_Fehler beim Laden von Tabelle ${table.id}: ${err instanceof Error ? err.message : String(err)}_\n\n`;
            }
          }
        } else {
          fullText += `_Keine passenden Tabellen gefunden. Nutze list_modules für eine Übersicht und get_schema für einzelne Tabellen._\n`;
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
