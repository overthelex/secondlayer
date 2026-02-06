# Document Analysis Integration

## Overview

Document analysis tools are integrated directly into the mcp_backend HTTP server, providing 4 MCP tools for parsing, analyzing, and comparing documents.

**Approach**: Direct integration (Variant 1) - No separate microservice needed.

## Available MCP Tools

### 1. `parse_document`
Parse documents (PDF/DOCX/HTML) with OCR support.

**Strategy**:
- PDF: Native text extraction → OCR via Playwright + Google Vision API
- DOCX: Mammoth → OCR fallback
- HTML: Screenshot + OCR

**Languages**: Ukrainian, Russian, English

**Parameters**:
```json
{
  "fileBase64": "base64-encoded file content",
  "mimeType": "application/pdf | application/vnd.openxmlformats-officedocument.wordprocessingml.document | text/html",
  "filename": "optional filename for logging"
}
```

### 2. `extract_key_clauses`
Extract key provisions from contracts/agreements.

**Clause Types**:
- Parties and subject matter
- Rights and obligations
- Terms and conditions
- Payments and finance
- Liability and penalties
- Force majeure and termination
- Confidentiality

**Risk Analysis**: Automatically identifies high/medium/low risk clauses.

**Parameters**:
```json
{
  "documentText": "text from parse_document",
  "documentId": "optional document ID"
}
```

### 3. `summarize_document`
Create executive and detailed summaries.

**Detail Levels**:
- `quick`: Executive summary only
- `standard`: Balanced summary
- `deep`: Comprehensive analysis with AI

**Output**:
- Executive summary (2-3 paragraphs)
- Detailed summary (by sections)
- Key facts: parties, dates, amounts

**Parameters**:
```json
{
  "documentText": "document text",
  "detailLevel": "quick | standard | deep"
}
```

### 4. `compare_documents`
Semantic comparison of two document versions.

**Change Classification**:
- **Critical**: Changes to amounts, dates, obligations
- **Significant**: New clauses, rights modifications
- **Minor**: Formatting, typos

**Uses**: Vector embeddings for semantic analysis + text-level diff.

**Parameters**:
```json
{
  "oldDocumentText": "old version text",
  "newDocumentText": "new version text"
}
```

## Architecture

### Integration Type: Direct (No Microservice)

**File**: `mcp_backend/src/http-server.ts`

```typescript
// DocumentAnalysisTools initialized directly in HTTP server
this.documentParser = new DocumentParser(visionKeyPath);
this.documentAnalysisTools = new DocumentAnalysisTools(
  this.documentParser,
  this.sectionizer,
  this.patternStore,
  this.citationValidator,
  this.embeddingService,
  this.documentService
);
```

**Registration**:
- MCP protocol: `ListToolsRequestSchema` handler (line ~546)
- HTTP API: `GET /api/tools` endpoint (line ~1033)

## Deployment Configuration

### Stage Environment

**File**: `deployment/docker-compose.stage.yml`

**Container**: `app-stage` (main HTTP server)

**Required Dependencies**:
1. ✅ Chromium (for Playwright) - included in `Dockerfile.mono-backend`
2. ✅ Vision API credentials - mounted as volume
3. ✅ Environment variables for Vision API

### Environment Variables

```yaml
environment:
  # Vision API credentials (inside container)
  VISION_CREDENTIALS_PATH: /app/credentials/vision-credentials.json
  GOOGLE_APPLICATION_CREDENTIALS: /app/credentials/vision-credentials.json
```

### Volume Mounts

```yaml
volumes:
  # Vision API credentials for document analysis (OCR)
  - ../vision-ocr-credentials.json:/app/credentials/vision-credentials.json:ro
```

### Credentials File

**Host path**: `/home/vovkes/SecondLayer/vision-ocr-credentials.json`
**Container path**: `/app/credentials/vision-credentials.json`
**Git status**: ✅ Already in `.gitignore`

## Testing

### 1. Check Tool Availability

```bash
curl -H "Authorization: Bearer YOUR_API_KEY" \
  https://stage.legal.org.ua/api/tools | jq '.tools[] | select(.name | startswith("parse_document", "extract_", "summarize_", "compare_"))'
```

### 2. Test Parse Document

```bash
# Base64 encode a PDF
base64 document.pdf > document.b64

# Call API
curl -X POST https://stage.legal.org.ua/api/tools/parse_document \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "fileBase64": "'$(cat document.b64)'",
    "mimeType": "application/pdf",
    "filename": "test.pdf"
  }'
```

### 3. Test Clause Extraction

```bash
curl -X POST https://stage.legal.org.ua/api/tools/extract_key_clauses \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "documentText": "ДОГОВІР ПІДРЯДУ\n\nСторони:\n1. Замовник: ТОВ \"Компанія А\"\n2. Підрядник: ФОП Іванов\n..."
  }'
```

## Cost Tracking

All document analysis operations are automatically tracked in the cost tracking system:

- Model: Selected based on `detailLevel` parameter (quick/standard/deep)
- Tokens: Prompt + completion tokens
- External APIs: Vision API calls (if OCR used)

**Cost table**: `cost_tracking`
**Monthly aggregation**: `monthly_api_usage`

## Error Handling

### Missing Vision Credentials

If Vision API credentials are not available:
- OCR operations will fail with clear error message
- Native text extraction (PDF/DOCX) still works
- Recommendation: Always provide valid credentials for production

### Common Issues

1. **"Document service is not configured"**
   → Check `VISION_CREDENTIALS_PATH` env variable
   → Verify volume mount in docker-compose.stage.yml

2. **"Failed to parse PDF"**
   → Check if Chromium is installed (should be in Dockerfile.mono-backend)
   → Verify `/tmp/document-parser` directory is writable

3. **"Vision API authentication failed"**
   → Verify credentials file is valid JSON
   → Check file permissions (should be readable by container)

## Benefits of Direct Integration (vs Microservice)

✅ **Simpler architecture**: No extra containers
✅ **Lower latency**: No network hop between services
✅ **Easier deployment**: Single service to manage
✅ **Cost tracking**: Built-in integration with billing system
✅ **Unified auth**: Same authentication for all tools

## Alternative: Microservice Approach

If you need to scale document analysis independently:

1. Use existing `mcp_backend/src/document-service.ts` (standalone HTTP server)
2. Add to docker-compose.stage.yml (see `docker-compose.yml` root file for reference)
3. Configure `DOCUMENT_SERVICE_URL` in main app
4. DocumentServiceClient will automatically proxy requests

**Note**: This is NOT currently needed for stage environment.

## Related Documentation

- `mcp_backend/docs/api-explorer.html` - Interactive API documentation
- `docs/ALL_MCP_TOOLS.md` - Complete tool list
- `CLAUDE.md` - Project architecture overview
