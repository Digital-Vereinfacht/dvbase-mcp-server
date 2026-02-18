# DVBase MCP Server

MCP Server für Digital Vereinfacht – gibt Claude direkten Zugriff auf das Ninox-Datenmodell der DVBase.

## Was macht das?

Claude kann damit:
- **Tabellen & Felder** eurer Ninox-DB einsehen (Schema)
- **Daten abfragen** via Ninox-Script (`select Rechnungen where Status = "Offen"`)
- **Kontextwissen** lesen (Prozessbeschreibungen, Stolperfallen, n8n-Abhängigkeiten)

## Installation (auf eurem Server)

### 1. Dateien auf den Server kopieren

```bash
# Archiv hochladen (z.B. per scp)
scp dvbase-mcp-server.tar.gz user@euer-server:~/

# Auf dem Server entpacken
ssh user@euer-server
tar xzf dvbase-mcp-server.tar.gz
cd dvbase-mcp-server
```

### 2. Dependencies installieren

```bash
npm install
```

### 3. Konfiguration (.env)

```bash
cp .env.example .env
nano .env
```

Dann ausfüllen:

```env
# Ninox API Key (Zahnrad → Integrationen → Generate)
NINOX_API_KEY=euer-key-hier

# Aus der Ninox-URL: https://app.ninox.com/#/teams/TEAM_ID/databases/DB_ID
NINOX_TEAM_ID=eure-team-id
NINOX_DATABASE_ID=eure-database-id

# Sicherheits-Token – generieren mit: openssl rand -hex 32
MCP_AUTH_TOKEN=euer-geheimer-token-hier

PORT=3001
```

### 4. Bauen & starten

```bash
npm run build
npm start
```

Testen ob's läuft:
```bash
curl http://localhost:3001/health
# → {"status":"ok","server":"dvbase-mcp","authEnabled":true, ...}
```

### 5. Mit nginx nach außen freigeben (für Claude.ai)

In eurer nginx-Konfig (z.B. `/etc/nginx/sites-available/default`):

```nginx
location /mcp {
    proxy_pass http://localhost:3001/mcp;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_http_version 1.1;

    # Wichtig für SSE/Streaming:
    proxy_set_header Connection '';
    proxy_buffering off;
    proxy_cache off;
    chunked_transfer_encoding on;
}
```

```bash
sudo nginx -t && sudo systemctl reload nginx
```

### 6. Dauerhaft laufen lassen (pm2)

```bash
# pm2 installieren falls noch nicht vorhanden
npm install -g pm2

# Server als Daemon starten
pm2 start dist/index.js --name dvbase-mcp

# Autostart nach Reboot
pm2 save
pm2 startup
```

## Verbindung herstellen

### Claude.ai (Browser)

1. Gehe zu **claude.ai → Settings → Integrations → MCP**
2. Trage ein:
   - **URL:** `https://eure-domain.de/mcp`
   - **Auth:** Bearer Token → euer `MCP_AUTH_TOKEN`

### Claude Desktop App

In `~/.config/Claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "dvbase": {
      "url": "http://localhost:3001/mcp",
      "headers": {
        "Authorization": "Bearer EUER_MCP_AUTH_TOKEN"
      }
    }
  }
}
```

## Verfügbare Tools

| Tool | Beschreibung |
|------|-------------|
| `list_modules` | Zeigt alle Tabellen der DVBase |
| `get_schema` | Felder, Typen, Optionen einer Tabelle |
| `get_context` | Entwickler-Kontextwissen (braucht Doku-Tabelle) |
| `get_full_module_info` | Schema + Kontext kombiniert |
| `query_data` | Ninox-Script Abfragen ausführen |

## Doku-Tabelle (optional)

Für `get_context` und `get_full_module_info` braucht ihr eine Tabelle in Ninox mit diesen Feldern:

| Feld | Typ | Inhalt |
|------|-----|--------|
| Modul | Text | Modulname (z.B. "Bautagesbericht") |
| Prozessbeschreibung | Text | Wie das Modul funktioniert |
| Stolperfallen | Text | Bekannte Probleme & Gotchas |
| N8N_Abhaengigkeiten | Text | Welche n8n-Workflows damit interagieren |
| Kundenspezifisch | Text | Kundenspezifische Anpassungen |
| Tabellen_Mapping | Text | Zugehörige Tabellen-IDs, komma-getrennt (z.B. "A,B,C") |

Die Table-ID dieser Tabelle kommt als `DOKU_TABLE_ID` in die `.env`.
