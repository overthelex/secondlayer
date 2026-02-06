# Stage Deployment: Document Analysis Integration

## Quick Start

Document analysis tools are already integrated in mcp_backend HTTP server. This guide shows how to deploy to stage.

## Prerequisites

✅ Vision API credentials file exists at: `/home/vovkes/SecondLayer/vision-ocr-credentials.json`
✅ File is in `.gitignore` (security)
✅ Dockerfile.mono-backend includes Chromium and Playwright

## Changes Made

### 1. Environment Variables

**File**: `deployment/docker-compose.stage.yml`

Added to `app-stage` service:
```yaml
environment:
  # Google Cloud Vision API (for OCR in document analysis tools)
  VISION_CREDENTIALS_PATH: /app/credentials/vision-credentials.json
  GOOGLE_APPLICATION_CREDENTIALS: /app/credentials/vision-credentials.json
```

### 2. Volume Mount

**File**: `deployment/docker-compose.stage.yml`

Added to `app-stage` volumes:
```yaml
volumes:
  # Vision API credentials for document analysis (OCR)
  - ../vision-ocr-credentials.json:/app/credentials/vision-credentials.json:ro
```

### 3. Code Update

**File**: `mcp_backend/src/http-server.ts`

Updated DocumentParser initialization to use env vars:
```typescript
// Use env var if set (for Docker), otherwise fallback to local path
const visionKeyPath = process.env.VISION_CREDENTIALS_PATH ||
                     process.env.GOOGLE_APPLICATION_CREDENTIALS ||
                     path.resolve(process.cwd(), '../vision-ocr-credentials.json');
this.documentParser = new DocumentParser(visionKeyPath);
```

## Deployment Steps

### 1. Build Updated Image

```bash
cd /home/vovkes/SecondLayer/deployment

# Build new image with updated http-server.ts
./manage-gateway.sh build
```

### 2. Deploy to Stage

```bash
# Deploy to stage environment
./manage-gateway.sh deploy stage

# Or restart stage if already running
./manage-gateway.sh restart stage
```

### 3. Verify Deployment

```bash
# Check logs for successful Vision API initialization
docker logs secondlayer-app-stage | grep -i "DocumentParser\|Vision\|document analysis"

# Check health
curl https://stage.legal.org.ua/health

# List available tools (should include 4 document analysis tools)
curl -H "Authorization: Bearer YOUR_API_KEY" \
  https://stage.legal.org.ua/api/tools | jq '.tools[] | select(.name | contains("document") or contains("clause") or contains("summarize") or contains("compare"))'
```

## Expected Tools

After deployment, the following MCP tools should be available:

1. ✅ `parse_document` - Parse PDF/DOCX/HTML with OCR
2. ✅ `extract_key_clauses` - Extract contract provisions
3. ✅ `summarize_document` - Create document summaries
4. ✅ `compare_documents` - Compare document versions

## Testing

### Test 1: Tool Availability

```bash
curl -s -H "Authorization: Bearer REDACTED_SL_KEY_STAGE_OLD" \
  https://stage.legal.org.ua/api/tools | \
  jq '.tools[] | select(.name | test("parse_document|extract_key_clauses|summarize_document|compare_documents")) | .name'
```

**Expected output**:
```
"parse_document"
"extract_key_clauses"
"summarize_document"
"compare_documents"
```

### Test 2: Parse Simple Document

Create test file `test-parse.json`:
```json
{
  "fileBase64": "JVBERi0xLjQKJeLjz9MKMyAwIG9iago8PC9UeXBlL1BhZ2UvUGFyZW50IDIgMCBSL1Jlc291cmNlczw8L0ZvbnQ8PC9GMSA1IDAgUj4+Pj4vTWVkaWFCb3hbMCAwIDYxMiA3OTJdL0NvbnRlbnRzIDQgMCBSPj4KZW5kb2JqCjQgMCBvYmoKPDwvTGVuZ3RoIDQ0Pj4Kc3RyZWFtCkJUCi9GMSA4IFRmCjEwMCA3MDAgVGQKKFRlc3QgRG9jdW1lbnQpIFRqCkVUCmVuZHN0cmVhbQplbmRvYmoKNSAwIG9iago8PC9UeXBlL0ZvbnQvU3VidHlwZS9UeXBlMS9CYXNlRm9udC9IZWx2ZXRpY2E+PgplbmRvYmoKMiAwIG9iago8PC9UeXBlL1BhZ2VzL0tpZHNbMyAwIFJdL0NvdW50IDE+PgplbmRvYmoKMSAwIG9iago8PC9UeXBlL0NhdGFsb2cvUGFnZXMgMiAwIFI+PgplbmRvYmoKdHJhaWxlcgo8PC9TaXplIDYvUm9vdCAxIDAgUj4+CnN0YXJ0eHJlZgo1NTIKJSVFT0YK",
  "mimeType": "application/pdf",
  "filename": "test.pdf"
}
```

Execute:
```bash
curl -X POST -H "Authorization: Bearer REDACTED_SL_KEY_STAGE_OLD" \
  -H "Content-Type: application/json" \
  -d @test-parse.json \
  https://stage.legal.org.ua/api/tools/parse_document
```

**Expected**: JSON response with parsed text and metadata.

### Test 3: Check Logs

```bash
# Check for errors
docker logs secondlayer-app-stage --tail 100 | grep -i error

# Check document analysis activity
docker logs secondlayer-app-stage --tail 100 | grep -i "MCP Tool.*document\|parse_document\|extract_key_clauses"
```

## Troubleshooting

### Issue: "Vision API authentication failed"

**Cause**: Credentials file not accessible or invalid

**Solution**:
```bash
# Verify file exists on host
ls -la /home/vovkes/SecondLayer/vision-ocr-credentials.json

# Check it's valid JSON
cat /home/vovkes/SecondLayer/vision-ocr-credentials.json | jq .

# Verify it's mounted in container
docker exec secondlayer-app-stage ls -la /app/credentials/vision-credentials.json

# Check env vars in container
docker exec secondlayer-app-stage env | grep VISION
```

### Issue: "DocumentParser initialization failed"

**Cause**: Missing Chromium or Playwright dependencies

**Solution**:
```bash
# Verify Chromium is installed in container
docker exec secondlayer-app-stage which chromium-browser

# Check Playwright env vars
docker exec secondlayer-app-stage env | grep PLAYWRIGHT
```

### Issue: Tools not appearing in /api/tools

**Cause**: DocumentAnalysisTools not registered

**Solution**:
```bash
# Rebuild with latest code
cd /home/vovkes/SecondLayer/mcp_backend
npm run build

# Rebuild Docker image
cd /home/vovkes/SecondLayer/deployment
./manage-gateway.sh build

# Redeploy
./manage-gateway.sh deploy stage
```

## Rollback

If something goes wrong:

```bash
# Stop stage
./manage-gateway.sh stop stage

# Check out previous version
git log --oneline -5
git checkout <previous-commit>

# Rebuild and deploy
./manage-gateway.sh build
./manage-gateway.sh deploy stage
```

## Monitoring

### Health Checks

```bash
# General health
curl https://stage.legal.org.ua/health

# Check tool count (should be 43 total: 34 backend + 4 rada + 5 openreyestr)
curl -s -H "Authorization: Bearer REDACTED_SL_KEY_STAGE_OLD" \
  https://stage.legal.org.ua/api/tools | jq '.count'
```

### Logs

```bash
# Follow logs in real-time
docker logs -f secondlayer-app-stage

# Search for document analysis activity
docker logs secondlayer-app-stage | grep -i "parse_document\|extract_key_clauses"

# Check for Vision API calls
docker logs secondlayer-app-stage | grep -i "vision\|ocr"
```

## Security Notes

1. ✅ Vision credentials file is in `.gitignore`
2. ✅ Mounted as read-only (`:ro`) in Docker
3. ✅ Not exposed in environment variables output
4. ✅ API keys required for all tool calls

## Next Steps

1. Deploy to stage: `./manage-gateway.sh deploy stage`
2. Test all 4 document analysis tools
3. Monitor logs for errors
4. Update API documentation if needed
5. Consider adding to production when stable

## Related Documentation

- `docs/DOCUMENT_ANALYSIS_INTEGRATION.md` - Full integration details
- `mcp_backend/docs/api-explorer.html` - Interactive API docs
- `docs/ALL_MCP_TOOLS.md` - Complete tool list
