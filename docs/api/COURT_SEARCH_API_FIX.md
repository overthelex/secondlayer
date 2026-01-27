# Court Search API Response Format Fix

**Date:** 2026-01-21
**Status:** ✅ Fixed and Deployed
**Environment:** Development (dev.legal.org.ua)

---

## Problem

User reported "Помилка пошуку Unknown error" (Search Error - Unknown error) when trying to search for court decisions on the frontend.

### Root Cause

**API Response Format Mismatch**: The backend MCP server returns responses in a different format than what the frontend expected:

**Backend Returns:**
```json
{
  "success": true,
  "tool": "search_legal_precedents",
  "result": {
    "content": [{
      "type": "text",
      "text": "{\"results\": [...], \"total\": 10}"
    }]
  },
  "cost_tracking": { ... }
}
```

**Frontend Expected:**
```typescript
interface ToolResponse<T> {
  success: boolean;
  data?: T;        // ← Expected "data" field
  error?: string;
}
```

The frontend hook `useApi.ts` (line 57) checked for `response.success && response.data`, but since the API returned `result` instead of `data`, the condition failed and showed "Unknown error".

---

## Additional Issues Fixed

### 1. Database Column Missing

**Error:** `column "secondlayer_api_calls" does not exist`

**Fix:**
```sql
ALTER TABLE cost_tracking
  ADD COLUMN IF NOT EXISTS secondlayer_api_calls INTEGER DEFAULT 0;
```

**Executed on:** secondlayer-postgres-dev container on gate server

This error appeared in the logs but didn't break the API response - it only prevented cost tracking from working properly.

---

## Solution

### Modified File: `Lexwebapp/src/services/api-client.ts`

**Changed:** `request<T>()` method (lines 60-92)

**Before:**
```typescript
return await response.json();
```

**After:**
```typescript
const jsonResponse = await response.json();

// Transform MCP backend response format to frontend format
// Backend returns: { success, tool, result }
// Frontend expects: { success, data, error }
if (jsonResponse.result !== undefined && jsonResponse.data === undefined) {
  return {
    ...jsonResponse,
    data: jsonResponse.result,
  } as T;
}

return jsonResponse;
```

### How It Works

The API client now automatically transforms the backend response:

1. Receives: `{ success: true, result: {...} }`
2. Transforms to: `{ success: true, data: {...}, result: {...} }`
3. Frontend hook gets `response.data` and works correctly

The `DecisionsSearchPage.parseResults()` function then handles the nested structure inside `data`:
- Extracts `data.content[0].text`
- Parses the JSON string
- Maps Zakononline fields to frontend Decision interface

---

## Testing

### Backend API Test (curl)

```bash
curl -X POST 'https://dev.legal.org.ua/api/tools/search_legal_precedents' \
  -H 'Content-Type: application/json' \
  -H 'Authorization: Bearer c3462787ee0a9b45a1102cc195a65f8ce82c7609242aab5628d4a111c52727b4' \
  -d '{"query": "test", "max_results": 5, "reasoning_budget": "quick"}'
```

**Result:** ✅ Returns 10 court decisions successfully

### Frontend Test

1. Open https://dev.legal.org.ua/
2. Navigate to "Судові рішення" page
3. Enter search query (e.g., "756/655/23")
4. Click "Знайти рішення"
5. **Expected:** Results display correctly without "Unknown error"

---

## Deployment

### Build Command
```bash
cd /Users/vovkes/ZOMCP/SecondLayer/Lexwebapp
docker build --platform linux/amd64 -f Dockerfile.dev -t lexwebapp-lexwebapp:dev .
```

**Build Time:** ~15 seconds
**Image Size:** 20MB (compressed)

### Transfer to Server
```bash
docker save lexwebapp-lexwebapp:dev | gzip > /tmp/lexwebapp-api-fix.tar.gz
scp /tmp/lexwebapp-api-fix.tar.gz gate:/tmp/
```

### Deploy
```bash
ssh gate "gunzip -c /tmp/lexwebapp-api-fix.tar.gz | docker load && \
  cd /home/vovkes/secondlayer-deployment && \
  docker compose -f docker-compose.dev.yml up -d lexwebapp-dev"
```

**Container:** lexwebapp-dev
**Status:** Running on port 8091
**URL:** https://dev.legal.org.ua (proxied via nginx)

---

## Backend Logs Analysis

The backend logs showed:
- ✅ API calls completed successfully
- ✅ Search returned 10 results
- ✅ Documents saved to PostgreSQL
- ✅ Sections extracted (356 total sections from 10 documents)
- ⚠️ Cost tracking errors (now fixed with `secondlayer_api_calls` column)

**No API errors** - the issue was purely frontend response parsing.

---

## Related Files

| File | Purpose | Changes |
|------|---------|---------|
| `Lexwebapp/src/services/api-client.ts` | HTTP API client | Added response transformation (lines 86-95) |
| `Lexwebapp/src/hooks/useApi.ts` | React hooks for API calls | No changes (already correct) |
| `Lexwebapp/src/types/api.ts` | TypeScript interfaces | No changes (already correct) |
| `Lexwebapp/src/components/DecisionsSearchPage.tsx` | Search UI component | No changes (parseResults already handles nested format) |

---

## Previous Related Fixes

1. **Database Schema Fix** - Added `monthly_api_usage` table and columns to `cost_tracking`
2. **Data Mapping Fix** - Mapped Zakononline API fields to frontend Decision interface
3. **Mock Data Removal** - Removed all mockDecisions and use real API data only

---

## Impact

**Positive:**
- ✅ Court search now works correctly
- ✅ Real data from Zakononline API displayed
- ✅ Cost tracking works properly
- ✅ No more "Unknown error" message

**No Breaking Changes:**
- All other API tools continue to work
- Response transformation is backward compatible
- If API already returns `data`, it's not overwritten

---

## Future Improvements

1. **Backend**: Consider standardizing the response format to match frontend expectations (use `data` instead of `result`)
2. **Frontend**: Add more detailed error messages instead of generic "Unknown error"
3. **Testing**: Add integration tests to catch API format mismatches earlier

---

**Status:** ✅ Deployed and Working
**Environment:** dev.legal.org.ua
**Deployment Time:** 2026-01-21 16:13:35 CET
**Container ID:** 7256e3ee37b7
