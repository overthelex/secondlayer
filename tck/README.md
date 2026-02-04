# Document Processing Scripts

Scripts to send documents to the document-service API and save parsed results.

## Container Information

- **Container ID**: `ad22359b90ad`
- **Service**: document-service:latest (document-analysis)
- **Port**: 3002
- **Status**: Running and healthy

## Supported File Types

- **PDF** (`.pdf`) - OCR via Google Vision API, optimized for Ukrainian documents
- **DOCX** (`.docx`, `.doc`) - Native extraction with mammoth, fallback to OCR
- **HTML** (`.html`, `.htm`) - DOM text extraction via Playwright

Languages supported: Ukrainian, Russian, English

## Usage

### Option 1: Bash Script (Recommended)

```bash
./process-documents.sh
```

This will:
- Find all PDF, DOCX, and HTML files in the current directory
- Send each file to the document-service API
- Save parsed text to `./parsed-results/filename.txt`
- Save full JSON response to `./parsed-results/filename.json`
- Display progress and summary

### Option 2: TypeScript Script

```bash
npx ts-node process-documents.ts
```

Requires `ts-node` to be installed.

## Output

All results are saved to `./parsed-results/`:
- `filename.txt` - Extracted text
- `filename.json` - Full API response with metadata
- `_summary.json` - Processing summary (TypeScript version only)

## API Endpoints

The document-service container provides these endpoints:

### Parse Document
```
POST http://localhost:3002/api/parse-document

Body:
{
  "fileBase64": "<base64-encoded-file>",
  "mimeType": "application/pdf | application/vnd.openxmlformats-officedocument.wordprocessingml.document | text/html",
  "filename": "document.pdf"
}
```

### Other Available Endpoints
- `POST /api/extract-clauses` - Extract key clauses from contracts
- `POST /api/summarize-document` - Summarize documents
- `POST /api/compare-documents` - Compare two document versions
- `GET /health` - Health check
- `GET /ready` - Readiness check

## Troubleshooting

- Ensure document-service container is running: `docker ps | grep document-service`
- Check container logs: `docker logs ad22359b90ad`
- Verify API health: `curl http://localhost:3002/health`
- PDFs are limited to first 5 pages for processing
