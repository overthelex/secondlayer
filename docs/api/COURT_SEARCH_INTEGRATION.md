# Court Decisions Search Integration

**Date:** 2026-01-21
**Status:** ✅ Backend Working, Frontend Needs Testing
**Environment:** Development (dev.legal.org.ua)

---

## Backend Status

### MCP API: ✅ Working

The backend `search_legal_precedents` tool is fully functional and connected to Zakononline API.

**Test Command:**
```bash
curl -X POST https://dev.legal.org.ua/api/tools/search_legal_precedents \
  -H 'Content-Type: application/json' \
  -H 'Authorization: Bearer REDACTED_SL_KEY_LOCAL' \
  -d '{"query": "позовна давність", "max_results": 5, "reasoning_budget": "quick"}'
```

**Sample Response:**
```json
{
  "success": true,
  "tool": "search_legal_precedents",
  "result": {
    "content": [{
      "type": "text",
      "text": "{\"results\": [...], \"total\": 10}"
    }]
  }
}
```

### Database: ✅ Fixed

**Problem:** Missing tables `monthly_api_usage` and columns in `cost_tracking`

**Solution Applied:**
```sql
-- Created monthly_api_usage table
CREATE TABLE monthly_api_usage (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  year_month VARCHAR(7) NOT NULL,
  zakononline_total_calls INTEGER DEFAULT 0,
  zakononline_total_cost_usd DECIMAL(10, 6) DEFAULT 0.00,
  -- ... other columns
  UNIQUE(year_month)
);

-- Added missing columns to cost_tracking
ALTER TABLE cost_tracking
  ADD COLUMN client_key VARCHAR(100),
  ADD COLUMN user_query TEXT,
  -- ... other columns
```

---

## Frontend Integration

### Page Location

**File:** `/Users/vovkes/ZOMCP/SecondLayer/Lexwebapp/src/components/DecisionsSearchPage.tsx`

**Route:** Should be accessible at `https://dev.legal.org.ua/decisions` (verify in routing)

### API Client Configuration

**File:** `/Users/vovkes/ZOMCP/SecondLayer/Lexwebapp/src/services/api-client.ts`

The frontend uses:
- `useSearchPrecedents()` hook from `src/hooks/useApi.ts`
- `apiClient.searchPrecedents(params)` method
- API URL: `https://dev.legal.org.ua` (from `.env.development`)
- API Key: `REDACTED_SL_KEY_LOCAL`

### Data Mapping Issue

**Problem:** API response structure doesn't match component expectations.

**API Returns (from Zakononline):**
```json
{
  "id": 129681974,
  "doc_id": 133348862,
  "cause_num": "686/31401/23",
  "court_code": "9931",
  "judge": "Коротун Вадим Михайлович",
  "adjudication_date": "2026-01-14T00:00:00.000Z",
  "resolution": "Про стягнення заборгованості",
  "snippet": "... позовна давність ..."
}
```

**Component Expects:**
```typescript
interface Decision {
  id: string;
  caseNumber: string;        // ← needs: cause_num
  court: string;              // ← needs: court name (have court_code)
  judge: string;              // ✓ OK
  date: string;               // ← needs: adjudication_date
  category: string;           // ← needs: category_code mapping
  parties: string;            // ← not in API
  summary: string;            // ← needs: snippet or resolution
  decisionType: string;       // ← needs: judgment_code mapping
  instance: string;           // ← needs: instance_code mapping
  relevance: number;          // ← needs calculation
}
```

**Current Mapping (lines 157-170):**
```typescript
const results: Decision[] = data?.results
  ? data.results.map((doc, idx) => ({
      id: doc.doc_id || idx.toString(),
      caseNumber: doc.case_number,        // ← undefined (should be cause_num)
      court: doc.court,                    // ← undefined (should be court_code)
      judge: doc.judge || 'Не вказано',
      date: doc.date,                      // ← undefined (should be adjudication_date)
      category: doc.category || 'Не визначено',
      parties: doc.parties || 'Не вказано',
      summary: doc.summary || 'Немає опису',
      decisionType: doc.decision_type || 'Рішення',
      instance: doc.instance || 'Не вказано',
      relevance: Math.round((doc.relevance_score || 0) * 100),
    }))
  : mockDecisions;
```

---

## Required Frontend Fixes

### 1. Fix Data Mapping

Update `DecisionsSearchPage.tsx` lines 156-170:

```typescript
const results: Decision[] = data?.results
  ? data.results.map((doc, idx) => ({
      id: doc.doc_id?.toString() || idx.toString(),
      caseNumber: doc.cause_num || 'Не вказано',
      court: mapCourtCode(doc.court_code) || 'Суд не визначено',
      judge: doc.judge || 'Не вказано',
      date: doc.adjudication_date || doc.law_date || '',
      category: mapCategoryCode(doc.category_code) || 'Не визначено',
      parties: doc.parties || extractPartiesFromTitle(doc.title) || 'Не вказано',
      summary: doc.snippet || doc.resolution || doc.title || 'Немає опису',
      decisionType: mapJudgmentCode(doc.judgment_code) || 'Рішення',
      instance: mapInstanceCode(doc.instance_code) || 'Не вказано',
      relevance: doc.weight ? Math.round((doc.weight / 15511) * 100) : 85,
    }))
  : mockDecisions;
```

### 2. Add Mapping Functions

Add helper functions for code mappings:

```typescript
// Court codes mapping (9931 = Верховний Суд КЦС, 9911 = ВС КГС, etc.)
const mapCourtCode = (code: string): string => {
  const courtMap: Record<string, string> = {
    '9931': 'Верховний Суд КЦС',
    '9911': 'Верховний Суд КГС',
    '9921': 'Верховний Суд КАС',
    '9941': 'Верховний Суд ККС',
    // Add more mappings as needed
  };
  return courtMap[code] || `Суд код ${code}`;
};

// Judgment codes (2 = Постанова, etc.)
const mapJudgmentCode = (code: string | number): string => {
  const judgmentMap: Record<string, string> = {
    '1': 'Рішення',
    '2': 'Постанова',
    '3': 'Ухвала',
    '4': 'Окрема думка',
  };
  return judgmentMap[code?.toString()] || 'Рішення';
};

// Instance codes (1 = Касаційна, etc.)
const mapInstanceCode = (code: string | number): string => {
  const instanceMap: Record<string, string> = {
    '1': 'Касаційна',
    '2': 'Апеляційна',
    '3': 'Перша',
  };
  return instanceMap[code?.toString()] || 'Не вказано';
};

// Category codes (1021 = specific category)
const mapCategoryCode = (code: number): string => {
  // TODO: Add category mapping based on Zakononline API docs
  return `Категорія ${code}`;
};

// Extract parties from title if not provided
const extractPartiesFromTitle = (title: string): string => {
  // Example: "Постанова від 14.01.2026 по справі № 686/31401/23"
  return ''; // TODO: Implement party extraction logic
};
```

### 3. Fix Search Handler

The search handler (lines 172-199) looks correct but needs to handle the nested response structure:

```typescript
const handleSearch = async () => {
  // ... existing code ...

  const response = await execute({
    query,
    reasoning_budget: 'quick', // or 'standard' for better results
    max_results: 20,
    source_case_number: filters.caseNumber || undefined,
  });

  // Check if response has nested structure
  if (response && response.result?.content?.[0]?.text) {
    try {
      const parsedData = JSON.parse(response.result.content[0].text);
      // parsedData.results will have the court decisions array
    } catch (e) {
      console.error('Failed to parse search results', e);
    }
  }
};
```

---

## Testing Steps

### 1. Open Search Page

1. Navigate to https://dev.legal.org.ua/
2. Login with Google OAuth
3. Find "Судові рішення" in the menu
4. Should see "Пошук судових рішень" page

### 2. Test Basic Search

1. Enter query: "позовна давність"
2. Click "Знайти рішення"
3. Should see loading state ("Пошук...")
4. Results should appear within 3-5 seconds

### 3. Verify Results Display

Each result should show:
- ✓ Case number (e.g., "686/31401/23")
- ✓ Court name (not just code)
- ✓ Judge name
- ✓ Date (formatted: DD.MM.YYYY)
- ✓ Summary/snippet
- ✓ Relevance percentage

### 4. Test Advanced Filters

Currently, advanced filters (court, judge, dates) are passed in the query string but not fully utilized by the backend. The backend does semantic search on the combined text.

**Future Enhancement:** Backend could support structured filters.

---

## Known Issues & Limitations

### 1. Empty Database
- PostgreSQL `documents` table is empty (count: 0)
- This is OK - backend fetches from Zakononline API directly
- Future: Can cache results in DB for faster repeat searches

### 2. Court Code Mapping
- API returns numeric court codes (e.g., "9931")
- Need mapping table to show user-friendly names
- Consider fetching court registry from Zakononline

### 3. Category Codes
- `category_code` is numeric (e.g., 1021)
- Need mapping to Ukrainian category names

### 4. Snippet HTML
- API returns `snippet` with HTML tags: `<b class="snippet">позовна давність</b>`
- Need to sanitize/strip HTML or render safely

### 5. Relevance Score
- API returns `weight()` field (e.g., 15511)
- Need to normalize to 0-100 scale
- Current formula: `(weight / max_weight) * 100`

---

## API Cost Tracking

The backend tracks API costs for each request:

**Zakononline Pricing:**
- Tier 1 (0-10,000 calls/month): $0.00714 per call
- Tier 2 (10,001-50,000): $0.00571 per call
- Tier 3 (50,001+): $0.00428 per call

**Cost per Search:**
- Quick search: ~$0.007 (1 Zakononline call)
- Standard search: ~$0.05 (with OpenAI analysis)
- Deep search: ~$0.15 (multiple OpenAI calls)

**Monthly Limits:**
- Current tier: Tier 1
- Used this month: 1 call
- Next tier at: 10,000 calls

---

## Next Steps

1. **Immediate (Frontend):**
   - [ ] Add data mapping functions
   - [ ] Update search results parsing
   - [ ] Test on dev.legal.org.ua
   - [ ] Add error handling for API failures

2. **Short-term (Backend):**
   - [ ] Add court code registry endpoint
   - [ ] Add category code mapping
   - [ ] Cache search results in PostgreSQL
   - [ ] Add support for structured filters

3. **Long-term:**
   - [ ] Semantic search using Qdrant vectors
   - [ ] Save search history per user
   - [ ] Export search results to CSV/PDF
   - [ ] Advanced pattern analysis

---

## References

- **Backend API:** https://dev.legal.org.ua/api/tools
- **MCP Tool:** `search_legal_precedents`
- **Zakononline API:** https://zakononline.ua/api/
- **Frontend Component:** `src/components/DecisionsSearchPage.tsx`
- **API Client:** `src/services/api-client.ts`

---

**Status:** Backend fully functional, frontend needs data mapping fixes to display results correctly.
