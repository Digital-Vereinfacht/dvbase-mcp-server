/**
 * Context Store for DVBase MCP Server
 * 
 * Manages developer context knowledge from a "Dokumentation" table in Ninox.
 * 
 * Expected Ninox table schema (field names):
 * - Modul (Text): Module name, e.g. "Bautagesbericht", "Faktura"
 * - Prozessbeschreibung (Text/Rich Text): How the module works
 * - Stolperfallen (Text/Rich Text): Known issues, gotchas
 * - N8N_Abhaengigkeiten (Text): Which n8n workflows interact with this module
 * - Kundenspezifisch (Text): Customer-specific variations
 * - Tabellen_Mapping (Text): Ninox table IDs belonging to this module (comma-separated)
 */

import { NinoxClient } from "./ninox-client.js";

export interface ModuleContext {
  moduleName: string;
  processDescription: string;
  knownIssues: string;
  n8nDependencies: string;
  customerSpecific: string;
  relatedTableIds: string[];
}

export class ContextStore {
  private ninoxClient: NinoxClient;
  private dokuTableId: string;

  // Cache all documentation records (small table, no need for per-module caching)
  private allRecordsCache: { data: Record<string, unknown>[]; expires: number } | null = null;
  private cacheTTL: number = 5 * 60 * 1000; // 5 minutes

  constructor(ninoxClient: NinoxClient, dokuTableId: string) {
    this.ninoxClient = ninoxClient;
    this.dokuTableId = dokuTableId;
  }

  /**
   * Fetch all documentation records (cached).
   * Uses GET /tables/{dokuTableId}/records with field names (not IDs).
   */
  private async getAllRecords(): Promise<Record<string, unknown>[]> {
    if (this.allRecordsCache && this.allRecordsCache.expires > Date.now()) {
      return this.allRecordsCache.data;
    }

    const records = await this.ninoxClient.getRecords(this.dokuTableId, {
      perPage: 250, // Should be plenty for documentation records
    });

    const data = records.map((r) => r.fields);

    this.allRecordsCache = {
      data,
      expires: Date.now() + this.cacheTTL,
    };

    return data;
  }

  /**
   * Get context for a specific module (case-insensitive match on "Modul" field)
   */
  async getModuleContext(moduleName: string): Promise<ModuleContext | null> {
    try {
      const allRecords = await this.getAllRecords();

      // Find matching record (case-insensitive)
      const record = allRecords.find(
        (fields) =>
          String(fields.Modul || "").toLowerCase() === moduleName.toLowerCase()
      );

      if (!record) {
        // Try partial match
        const partialMatch = allRecords.find(
          (fields) =>
            String(fields.Modul || "")
              .toLowerCase()
              .includes(moduleName.toLowerCase()) ||
            moduleName
              .toLowerCase()
              .includes(String(fields.Modul || "").toLowerCase())
        );

        if (!partialMatch) return null;
        return this.recordToContext(partialMatch, moduleName);
      }

      return this.recordToContext(record, moduleName);
    } catch (error) {
      console.error(
        `Error fetching context for module "${moduleName}":`,
        error
      );
      return null;
    }
  }

  private recordToContext(
    fields: Record<string, unknown>,
    fallbackName: string
  ): ModuleContext {
    return {
      moduleName: String(fields.Modul || fallbackName),
      processDescription: String(fields.Prozessbeschreibung || ""),
      knownIssues: String(fields.Stolperfallen || ""),
      n8nDependencies: String(fields.N8N_Abhaengigkeiten || ""),
      customerSpecific: String(fields.Kundenspezifisch || ""),
      relatedTableIds: String(fields.Tabellen_Mapping || "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean),
    };
  }

  /**
   * List all documented modules
   */
  async listModules(): Promise<string[]> {
    try {
      const allRecords = await this.getAllRecords();
      return allRecords
        .map((fields) => String(fields.Modul || ""))
        .filter(Boolean);
    } catch (error) {
      console.error("Error listing modules:", error);
      return [];
    }
  }

  /**
   * Clear the cache (useful after updates)
   */
  clearCache(): void {
    this.allRecordsCache = null;
  }
}
