# RADA MCP Server - Implementation Status

## ✅ Completed Components (14/29 tasks)

### 1. Project Structure
- ✅ Complete directory tree (`src/`, `scripts/`, `docker/`, `logs/`)
- ✅ All subdirectories created

### 2. Configuration Files
- ✅ `package.json` - Dependencies and scripts configured
- ✅ `tsconfig.json` - CommonJS TypeScript configuration
- ✅ `.env.example` - Complete environment template
- ✅ `README.md` - Comprehensive documentation

### 3. Database Layer
- ✅ `src/database/database.ts` - PostgreSQL connection pool
- ✅ `src/migrations/001_initial_schema.sql` - Core tables
- ✅ `src/migrations/002_add_cost_tracking.sql` - Cost tracking
- ✅ `src/migrations/003_add_cross_reference.sql` - SecondLayer integration
- ✅ `src/migrations/migrate.ts` - Migration runner

### 4. Type Definitions
- ✅ `src/types/index.ts` - Core RADA types (Deputy, Bill, Legislation, etc.)
- ✅ `src/types/cost.ts` - Cost tracking types
- ✅ `src/types/rada.ts` - RADA API types and known laws mapping

### 5. Utilities
- ✅ `src/utils/logger.ts` - Winston logger
- ✅ `src/utils/model-selector.ts` - Budget-based model selection

### 6. Infrastructure
- ✅ `scripts/create-db.sh` - Database creation script
- ✅ `Dockerfile` - Node.js 20 Alpine container
- ✅ `docker-compose.yml` - PostgreSQL, Redis, app orchestration

---

## 🔨 Remaining Implementation (15 components)

Below are the components that need to be implemented. Each section includes:
- **Purpose** - What the component does
- **Dependencies** - What it requires
- **Reference** - SecondLayer file to copy/adapt from
- **Key changes** - RADA-specific modifications needed

---

### PRIORITY 1: Core Dependencies

#### 1. `src/utils/llm-client-manager.ts`

**Purpose:** Manages OpenAI and Anthropic clients with automatic retry, rotation, and error handling.

**Reference:** `/Users/vovkes/ZOMCP/SecondLayer/mcp_backend/src/utils/llm-client-manager.ts`

**Copy and adapt:**
- Keep the same structure (OpenAIClientManager, AnthropicClientManager)
- Update logger import: `from './logger'` (no .js extension)
- Keep retry logic, token rotation, rate limit handling
- Keep AsyncLocalStorage for cost tracking context

**No RADA-specific changes needed** - this is generic LLM client management.

---

#### 2. `src/adapters/rada-api-adapter.ts`

**Purpose:** Fetches data from data.rada.gov.ua API (deputies, bills, voting).

**Reference:** `/Users/vovkes/ZOMCP/SecondLayer/mcp_backend/src/adapters/zo-adapter.ts` (for structure)

**Key structure:**
```typescript
import axios from 'axios';
import { logger } from '../utils/logger';
import { RadaDeputyRawData, RadaBillRawData, RadaAPIError } from '../types/rada';

export class RadaAPIAdapter {
  private client: AxiosInstance;
  private baseURL = 'https://data.rada.gov.ua';

  constructor() {
    this.client = axios.create({
      baseURL: this.baseURL,
      timeout: 30000,
      headers: {
        'Accept': 'application/json',
        'User-Agent': 'RADA-MCP/1.0',
      },
    });
  }

  async fetchDeputies(convocation: number = 9): Promise<RadaDeputyRawData[]> {
    // GET /ogd/mps/skl9/mps_skl9.json
  }

  async fetchBills(filters?: { dateFrom?: string; dateTo?: string }): Promise<RadaBillRawData[]> {
    // GET /ogd/zpr/skl9/...
  }

  async fetchVoting(date: string): Promise<any> {
    // GET /ogd/zal/skl9/plenary/...
  }
}
```

**RADA-specific:**
- Endpoints: `/ogd/mps/skl9/mps_skl9.json`, `/ogd/zpr/...`, `/ogd/zal/...`
- No authentication required (open data)
- Handle gzip/deflate compression
- Track API usage for cost monitoring (free but track bandwidth)

---

#### 3. `src/adapters/zakon-rada-adapter.ts`

**Purpose:** Fetches law texts from zakon.rada.gov.ua.

**Reference:** Similar to rada-api-adapter, but for zakon.rada.gov.ua

**Key structure:**
```typescript
import axios from 'axios';
import * as cheerio from 'cheerio';
import { KNOWN_LAWS } from '../types/rada';

export class ZakonRadaAdapter {
  private baseURL = 'https://zakon.rada.gov.ua';

  resolveLawNumber(aliasOrNumber: string): string {
    return KNOWN_LAWS[aliasOrNumber.toLowerCase()] || aliasOrNumber;
  }

  async fetchLawText(lawNumber: string): Promise<{
    title: string;
    html: string;
    plainText: string;
    articles: any[];
  }> {
    // GET /laws/show/{lawNumber}
    // Parse HTML with Cheerio
  }

  async searchLaws(keyword: string): Promise<any[]> {
    // GET /laws/search?q={keyword}
  }
}
```

---

### PRIORITY 2: Services Layer

#### 4. `src/services/cost-tracker.ts`

**Purpose:** Tracks API usage and costs for transparency.

**Reference:** `/Users/vovkes/ZOMCP/SecondLayer/mcp_backend/src/services/cost-tracker.ts`

**Copy and adapt:**
- Keep AsyncLocalStorage pattern
- Update for RADA: track rada_api_calls, rada_api_cached, rada_api_bytes
- Keep OpenAI/Anthropic tracking
- Add SecondLayer API tracking for cross-referencing
- Use Database class for PostgreSQL queries

---

#### 5. `src/services/deputy-service.ts`

**Purpose:** Deputy CRUD with cache-first strategy.

**Key structure:**
```typescript
import { Database } from '../database/database';
import { RadaAPIAdapter } from '../adapters/rada-api-adapter';
import { Deputy } from '../types';

export class DeputyService {
  constructor(
    private db: Database,
    private radaAdapter: RadaAPIAdapter
  ) {}

  async getDeputy(radaId: string): Promise<Deputy> {
    // Check cache: SELECT * FROM deputies WHERE rada_id = $1 AND cache_expires_at > NOW()
    // If expired: fetch from API, upsert to DB with 7-day TTL
  }

  async searchDeputies(params: { name?, faction?, committee?, active? }): Promise<Deputy[]> {
    // SQL query with filters
  }

  async syncAllDeputies(): Promise<void> {
    // Bulk fetch from API, upsert all
  }
}
```

---

#### 6. `src/services/bill-service.ts`

**Purpose:** Bill CRUD with 1-day cache (bills change frequently).

**Similar to DeputyService** but:
- 1-day cache TTL instead of 7 days
- Filter by status, initiator, committee, date range
- Parse bill_number format (e.g., "1234-IX")

---

#### 7. `src/services/legislation-service.ts`

**Purpose:** Law text retrieval with 30-day cache.

**Key structure:**
```typescript
export class LegislationService {
  constructor(
    private db: Database,
    private zakonAdapter: ZakonRadaAdapter
  ) {}

  async getLaw(lawIdentifier: string): Promise<Legislation> {
    // Resolve alias: constitution -> 254к/96-вр
    // Check cache (30-day TTL)
    // If expired: fetch from zakon.rada.gov.ua
  }

  async searchInLaw(lawNumber: string, searchText: string): Promise<any[]> {
    // Full-text search in full_text_plain or articles JSONB
  }
}
```

---

#### 8. `src/services/voting-service.ts`

**Purpose:** Voting record analysis.

**Key methods:**
```typescript
export class VotingService {
  async analyzeDeputyVoting(radaId: string, filters?: {
    dateFrom?, dateTo?, billNumber?
  }): Promise<VotingStatistics> {
    // Query voting_records WHERE votes->radaId IS NOT NULL
    // Calculate: total_votes, voted_for/against/abstain, attendance_rate
    // Return positions array
  }

  async analyzeVotingPatterns(radaId: string): Promise<VotingPattern[]> {
    // Use LLM to identify patterns (requires LLMClientManager)
    // E.g., "Always votes with faction", "Independent on tax issues"
  }
}
```

---

#### 9. `src/services/cross-reference-service.ts`

**Purpose:** Link RADA data to SecondLayer court cases.

**Key structure:**
```typescript
export class CrossReferenceService {
  constructor(
    private db: Database,
    private secondLayerURL?: string,
    private secondLayerKey?: string
  ) {}

  async findCourtCasesCitingLaw(lawNumber: string, article?: string): Promise<any[]> {
    // Call SecondLayer API: POST /api/tools/search_legal_precedents
    // Store results in law_court_citations table
  }

  async analyzeBillImpact(billNumber: string): Promise<any> {
    // Get bill -> find law it amends -> find court cases citing that law
  }
}
```

**Requires:** axios to call SecondLayer HTTP API

---

### PRIORITY 3: API Layer

#### 10. `src/middleware/dual-auth.ts`

**Purpose:** JWT + API key authentication.

**Reference:** `/Users/vovkes/ZOMCP/SecondLayer/mcp_backend/src/middleware/dual-auth.ts`

**Copy exactly** - no RADA-specific changes needed. Just update:
- Logger import: `from '../utils/logger'`
- Environment: `RADA_API_KEYS` instead of `SECONDARY_LAYER_KEYS`

---

#### 11. `src/api/mcp-rada-api.ts`

**Purpose:** MCP tools definition and routing.

**Reference:** `/Users/vovkes/ZOMCP/SecondLayer/mcp_backend/src/api/mcp-query-api.ts`

**Structure:**
```typescript
export class MCPRadaAPI {
  constructor(
    private deputyService: DeputyService,
    private billService: BillService,
    private legislationService: LegislationService,
    private votingService: VotingService,
    private crossRefService: CrossReferenceService,
    private costTracker: CostTracker
  ) {}

  getTools() {
    return [
      {
        name: 'search_parliament_bills',
        description: '...',
        inputSchema: { ... }
      },
      {
        name: 'get_deputy_info',
        description: '...',
        inputSchema: { ... }
      },
      {
        name: 'search_legislation_text',
        description: '...',
        inputSchema: { ... }
      },
      {
        name: 'analyze_voting_record',
        description: '...',
        inputSchema: { ... }
      },
    ];
  }

  async handleToolCall(toolName: string, args: any): Promise<any> {
    switch (toolName) {
      case 'search_parliament_bills':
        return await this.searchParliamentBills(args);
      // ... other tools
    }
  }

  private async searchParliamentBills(args: any) {
    // 1. Validate args
    // 2. Call billService.searchBills()
    // 3. Return MCP response format
    return {
      content: [{ type: 'text', text: JSON.stringify(result, null, 2) }]
    };
  }
}
```

**Tool schemas** are defined in the plan at `/Users/vovkes/.claude/plans/sorted-floating-stardust.md`.

---

### PRIORITY 4: Entry Points

#### 12. `src/index.ts` (MCP stdio)

**Purpose:** MCP stdio server for AI assistant integration.

**Reference:** `/Users/vovkes/ZOMCP/SecondLayer/mcp_backend/src/index.ts`

**Copy and adapt:**
- Import MCPRadaAPI instead of MCPQueryAPI
- Instantiate all services
- Setup MCP SDK stdio transport
- Register tools with `server.setRequestHandler(ListToolsRequestSchema, ...)`

---

#### 13. `src/http-server.ts` (HTTP REST)

**Purpose:** HTTP server with SSE streaming support.

**Reference:** `/Users/vovkes/ZOMCP/SecondLayer/mcp_backend/src/http-server.ts`

**Copy and adapt:**
- Import MCPRadaAPI
- Setup Express with dual-auth middleware
- Routes:
  - `GET /health`
  - `GET /api/tools`
  - `POST /api/tools/:toolName`
  - `POST /api/tools/:toolName/stream` (SSE)
- Cost tracking integration
- Port 3001 (not 3000)

---

### PRIORITY 5: Data Sync Scripts

#### 14. `scripts/sync-deputies.ts`

**Purpose:** Bulk sync all deputies from data.rada.gov.ua.

**Structure:**
```typescript
import { Database } from '../src/database/database';
import { RadaAPIAdapter } from '../src/adapters/rada-api-adapter';
import { DeputyService } from '../src/services/deputy-service';

async function syncDeputies() {
  const db = new Database();
  await db.connect();

  const radaAdapter = new RadaAPIAdapter();
  const deputyService = new DeputyService(db, radaAdapter);

  await deputyService.syncAllDeputies();

  await db.close();
}

syncDeputies();
```

**Run:** `npm run sync:deputies`

---

#### 15. `scripts/sync-laws.ts`

**Purpose:** Bulk sync common laws (constitution, codes).

**Structure:**
```typescript
import { KNOWN_LAWS } from '../src/types/rada';
import { LegislationService } from '../src/services/legislation-service';

async function syncLaws() {
  // For each law in KNOWN_LAWS
  //   legislationService.getLaw(lawNumber)
  //   (will fetch and cache)
}

syncLaws();
```

**Run:** `npm run sync:laws`

---

## 📋 Implementation Order

Follow this order to minimize circular dependencies:

1. **LLMClientManager** (no dependencies)
2. **RadaAPIAdapter** + **ZakonRadaAdapter** (no dependencies)
3. **CostTracker** (depends on: Database, LLMClientManager)
4. **Services** (depends on: Database, Adapters, CostTracker)
   - DeputyService
   - BillService
   - LegislationService
   - VotingService
   - CrossReferenceService
5. **Middleware** (dual-auth - no dependencies)
6. **MCPRadaAPI** (depends on: all services)
7. **Entry points** (depends on: MCPRadaAPI, middleware)
   - index.ts
   - http-server.ts
8. **Scripts** (depends on: services)

---

## 🧪 Testing Checklist

After implementation:

### 1. Database Setup
```bash
npm run db:setup
npm run migrate

# Verify tables
psql -U rada_mcp -d rada_db -c "\dt"
# Should see: deputies, bills, legislation, voting_records, cost_tracking, etc.
```

### 2. Data Sync
```bash
npm run sync:deputies
# Check: SELECT COUNT(*) FROM deputies;

npm run sync:laws
# Check: SELECT COUNT(*) FROM legislation;
```

### 3. HTTP API Test
```bash
# Start server
npm run dev:http

# Test deputy info
curl -X POST http://localhost:3001/api/tools/get_deputy_info \
  -H "Authorization: Bearer test-key-123" \
  -H "Content-Type: application/json" \
  -d '{"arguments": {"name": "Зеленський"}}'

# Should return deputy data or error if not synced
```

### 4. Cost Tracking
```bash
# After tool call, check cost_tracking table
psql -U rada_mcp -d rada_db -c "SELECT * FROM cost_tracking ORDER BY created_at DESC LIMIT 1;"
# Should show request_id, tool_name, costs
```

### 5. Docker Deployment
```bash
docker-compose up -d
docker-compose logs -f app

# Should see:
# - Database connected
# - Migrations applied
# - HTTP server listening on port 3001
```

---

## 📚 Reference Files

When implementing, refer to these SecondLayer files:

| RADA Component | SecondLayer Reference |
|----------------|----------------------|
| LLMClientManager | `mcp_backend/src/utils/llm-client-manager.ts` |
| API Adapter | `mcp_backend/src/adapters/zo-adapter.ts` |
| CostTracker | `mcp_backend/src/services/cost-tracker.ts` |
| Service pattern | `mcp_backend/src/services/document-service.ts` |
| Dual-auth | `mcp_backend/src/middleware/dual-auth.ts` |
| MCP API | `mcp_backend/src/api/mcp-query-api.ts` |
| MCP stdio | `mcp_backend/src/index.ts` |
| HTTP server | `mcp_backend/src/http-server.ts` |

---

## 🎯 Success Criteria

Implementation is complete when:

- ✅ All 15 remaining components implemented
- ✅ `npm run build` succeeds with no errors
- ✅ Database migrations run successfully
- ✅ Data sync scripts populate database
- ✅ HTTP API responds to tool calls
- ✅ Cost tracking records API usage
- ✅ Docker compose brings up all services
- ✅ MCP stdio works in Claude Desktop (optional)

---

## 💡 Tips

1. **Copy SecondLayer patterns** - Don't reinvent, adapt
2. **Test incrementally** - Test each service as you build it
3. **Use logger extensively** - `logger.info()`, `logger.error()`
4. **Check .env** - Most issues are missing environment variables
5. **PostgreSQL ports** - RADA uses 5433, SecondLayer uses 5432
6. **Cost tracking** - Every tool call should create a cost_tracking record
7. **Cache strategy** - Deputies 7d, Bills 1d, Laws 30d

---

## 📞 Need Help?

- **Plan document:** `/Users/vovkes/.claude/plans/sorted-floating-stardust.md`
- **SecondLayer codebase:** `/Users/vovkes/ZOMCP/SecondLayer/mcp_backend/`
- **RADA data:** `/Users/vovkes/ZOMCP/SecondLayer/RADA/`
