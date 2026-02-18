/**
 * Ninox API Client for DVBase MCP Server
 * Based on official Ninox Public Cloud API documentation:
 * https://forum.ninox.com/t/35yzp89/api-endpoints-for-public-cloud
 *
 * Base URL: https://api.ninox.com/v1/teams/{teamId}/databases/{dbId}
 */

export interface NinoxConfig {
  apiKey: string;
  teamId: string;
  databaseId: string;
  baseUrl?: string; // Override for Private Cloud: https://{host}.ninoxdb.de/v1
}

// --- API Response Types ---

/**
 * Table listing response (GET /tables)
 * Each table has an id (A, B, ... AA, AB), a human-readable name, and fields.
 */
export interface NinoxTable {
  id: string;    // e.g. "A", "B", "AA"
  name: string;  // Human-readable name
  fields: NinoxField[];
}

/**
 * Field definition within a table schema.
 * Field types: text, number, date, datetime, timeinterval, time,
 *              appointment, boolean, choice, url, email, phone, location, html
 *
 * IDs are stable over the lifetime of a database (A, B, ... AA, AB, etc.)
 */
export interface NinoxField {
  id: string;       // e.g. "A", "B", "C1"
  name: string;     // Human-readable field name
  type: string;     // Field type (see above)
  choices?: NinoxChoice[];
  [key: string]: unknown;
}

export interface NinoxChoice {
  id: string;
  caption: string;
  captions?: Record<string, string>;
}

/**
 * Full table schema (GET /tables/{tid})
 */
export interface NinoxTableSchema {
  id: string;
  name: string;
  fields: NinoxField[];
}

/**
 * Record as returned by GET /tables/{tid}/records
 */
export interface NinoxRecord {
  id: number;
  sequence?: number;
  createdAt?: string;
  createdBy?: string | number;
  modifiedAt?: string;
  modifiedBy?: string;
  fields: Record<string, unknown>;
}

/**
 * Query parameters for record retrieval
 */
export interface RecordQueryOptions {
  filters?: Record<string, unknown>;
  page?: number;
  perPage?: number;
  order?: string;
  desc?: boolean;
  new?: boolean;
  updated?: boolean;
  sinceId?: number;
  sinceSq?: number;
  ids?: boolean;
  choiceStyle?: "ids" | "names";
}

export class NinoxClient {
  private config: NinoxConfig;
  private baseUrl: string;

  constructor(config: NinoxConfig) {
    this.config = config;
    const apiRoot = config.baseUrl || "https://api.ninox.com/v1";
    this.baseUrl = `${apiRoot}/teams/${config.teamId}/databases/${config.databaseId}`;
  }

  private async request<T>(endpoint: string, options?: RequestInit): Promise<T> {
    const url = `${this.baseUrl}${endpoint}`;
    const response = await fetch(url, {
      ...options,
      headers: {
        Authorization: `Bearer ${this.config.apiKey}`,
        "Content-Type": "application/json",
        ...options?.headers,
      },
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(
        `Ninox API error: ${response.status} ${response.statusText} - ${errorText}`
      );
    }

    return response.json() as Promise<T>;
  }

  // ========================================
  // Schema Endpoints
  // ========================================

  /**
   * List all tables with their field definitions.
   * GET /tables
   */
  async listTables(): Promise<NinoxTable[]> {
    return this.request<NinoxTable[]>("/tables");
  }

  /**
   * Get the full schema for a specific table.
   * GET /tables/{tableId}
   *
   * Returns: { id, name, fields: [{ id, name, type, choices?, ... }] }
   */
  async getTableSchema(tableId: string): Promise<NinoxTableSchema> {
    return this.request<NinoxTableSchema>(`/tables/${tableId}`);
  }

  /**
   * Get the complete database schema (all tables with all fields).
   * Uses GET /tables which already includes field definitions.
   * Falls back to individual table fetches if fields are empty.
   */
  async getFullSchema(): Promise<NinoxTableSchema[]> {
    const tables = await this.listTables();
    const hasFields = tables.some((t) => t.fields && t.fields.length > 0);

    if (hasFields) {
      return tables as NinoxTableSchema[];
    }

    // Fields were empty in listing, fetch each individually
    const schemas = await Promise.all(
      tables.map((table) => this.getTableSchema(table.id))
    );
    return schemas;
  }

  // ========================================
  // Record Endpoints
  // ========================================

  /**
   * Get records from a table.
   * GET /tables/{tableId}/records
   */
  async getRecords(
    tableId: string,
    options?: RecordQueryOptions
  ): Promise<NinoxRecord[]> {
    const params = new URLSearchParams();

    if (options?.filters) {
      params.set("filters", JSON.stringify(options.filters));
    }
    if (options?.perPage !== undefined) {
      params.set("perPage", String(options.perPage));
    }
    if (options?.page !== undefined) {
      params.set("page", String(options.page));
    }
    if (options?.order) {
      params.set("order", options.order);
    }
    if (options?.desc) {
      params.set("desc", "true");
    }
    if (options?.new) {
      params.set("new", "true");
    }
    if (options?.updated) {
      params.set("updated", "true");
    }
    if (options?.sinceId !== undefined) {
      params.set("sinceId", String(options.sinceId));
    }
    if (options?.sinceSq !== undefined) {
      params.set("sinceSq", String(options.sinceSq));
    }
    if (options?.ids !== undefined) {
      params.set("ids", String(options.ids));
    }
    if (options?.choiceStyle) {
      params.set("choiceStyle", options.choiceStyle);
    }

    const query = params.toString();
    const endpoint = `/tables/${tableId}/records${query ? `?${query}` : ""}`;
    return this.request<NinoxRecord[]>(endpoint);
  }

  /**
   * Get a single record by ID.
   * GET /tables/{tableId}/records/{recordId}
   */
  async getRecord(tableId: string, recordId: number): Promise<NinoxRecord> {
    return this.request<NinoxRecord>(
      `/tables/${tableId}/records/${recordId}`
    );
  }

  // ========================================
  // Query Endpoint (Ninox Script)
  // ========================================

  /**
   * Execute a read-only Ninox script query.
   * POST /query
   *
   * Example: (select Kontakte).'Name'
   */
  async executeQuery(query: string): Promise<unknown> {
    return this.request<unknown>("/query", {
      method: "POST",
      body: JSON.stringify({ query }),
    });
  }

  /**
   * Execute a writable Ninox script (can modify data).
   * POST /exec
   * ⚠️ Use with caution!
   */
  async executeWritableQuery(query: string): Promise<unknown> {
    return this.request<unknown>("/exec", {
      method: "POST",
      body: JSON.stringify({ query }),
    });
  }
}
