# 📦 Batch Document Processing - Complete Implementation

Full implementation of batch document processing system for SecondLayer MCP, optimized for processing thousands of documents with real-time progress tracking in Cursor IDE.

## ✅ What's Included

### Backend Components

- ✅ **BatchDocumentTools** (`mcp_backend/src/api/batch-document-tools.ts`)
  - Concurrent processing with rate limiting
  - SSE progress streaming
  - Automatic retry logic
  - Cost tracking and estimation
  - Support for 3 operations: parse, extract_clauses, summarize

- ✅ **HTTP Server Integration** (`mcp_backend/src/http-server.ts`)
  - New endpoint: `POST /api/tools/batch_process_documents`
  - SSE streaming: `POST /api/tools/batch_process_documents/stream`
  - Integrated with existing auth, billing, and cost tracking

- ✅ **MCP SSE Server Integration** (`mcp_backend/src/api/mcp-sse-server.ts`)
  - Added batch_process_documents to tool registry
  - Compatible with ChatGPT web integration

### Client Tools

- ✅ **Batch Processor Script** (`scripts/batch-process-documents.ts`)
  - CLI tool for Cursor IDE
  - Real-time progress display
  - Cost estimation and tracking
  - Resume support for interrupted batches
  - Automatic chunking and rate limiting

### Documentation

- ✅ **Quick Start Guide** (`BATCH_PROCESSING_QUICKSTART.md`)
  - 5-minute setup
  - Common use cases
  - Cost calculator

- ✅ **Complete Guide** (`docs/BATCH_PROCESSING_GUIDE.md`)
  - Detailed configuration
  - Performance tuning
  - Troubleshooting
  - API reference

- ✅ **Examples** (`examples/batch-processing-examples.sh`)
  - 10 real-world scenarios
  - Cost and time estimates
  - Cursor integration examples

## 🚀 Quick Start

### 1. Install Dependencies

```bash
cd /home/vovkes/SecondLayer
npm run install:all
```

### 2. Configure Environment

```bash
export SECONDLAYER_API_KEY=your-api-key-here
export SECONDLAYER_API_URL=http://localhost:3000
```

### 3. Start Backend

```bash
# Terminal 1: Backend
cd mcp_backend
npm run dev:http
```

### 4. Process Documents

```bash
# Example: 4000 images
npm run batch-process -- \
  --input ./images \
  --operations parse \
  --concurrency 10

# Example: 1000 PDFs with analysis
npm run batch-process -- \
  --input ./pdfs \
  --operations parse,extract_clauses,summarize \
  --concurrency 5
```

## 📊 Use Cases

| Use Case | Files | Operations | Time | Cost |
|----------|-------|-----------|------|------|
| **4000 scanned images** | 4000 | parse | 2-4h | $6.00 |
| **1000 PDF documents** | 1000 | parse, summarize | 1-2h | $1.80 |
| **500 legal contracts** | 500 | parse, extract, summarize | 45-90m | $1.05 |
| **Quick test batch** | 100 | parse, summarize | <5m | $0.15 |
| **Deep analysis** | 50 | parse, extract, summarize (deep) | 15-30m | $0.25 |

## 📁 File Structure

```
SecondLayer/
├── mcp_backend/
│   └── src/
│       └── api/
│           ├── batch-document-tools.ts        # ✨ NEW: Core batch processing
│           ├── document-analysis-tools.ts     # Updated: Used by batch
│           ├── mcp-sse-server.ts             # Updated: Batch support
│           └── mcp-query-api.ts              # Existing
├── scripts/
│   └── batch-process-documents.ts            # ✨ NEW: Cursor CLI tool
├── examples/
│   └── batch-processing-examples.sh          # ✨ NEW: Usage examples
├── docs/
│   └── BATCH_PROCESSING_GUIDE.md             # ✨ NEW: Complete guide
├── BATCH_PROCESSING_QUICKSTART.md            # ✨ NEW: Quick start
├── BATCH_PROCESSING_README.md                # ✨ NEW: This file
└── package.json                               # Updated: New scripts
```

## 🎯 Features

### Real-time Progress

```
📦 SecondLayer Batch Document Processor

✓ Found 1000 files to process

⚙️  Configuration:
   Operations:    parse, summarize
   Concurrency:   5

💰 Cost Estimation:
   Per file:      ~$0.0018
   Total:         ~$1.80

🔄 Processing 1000 files in 10 chunks

📦 Chunk 1/10 (100 files)
   ✓ [0.1%] contract001.pdf ($0.0018) 0.5s
   ✓ [0.2%] contract002.pdf ($0.0018) 0.6s
   ✓ [0.3%] contract003.pdf ($0.0018) 0.4s
   ...
```

### Resume Support

Interrupted batches can be resumed:

```bash
# First run (interrupted)
npm run batch-process -- --input ./docs --resume

# Resume later - picks up where you left off
npm run batch-process -- --input ./docs --resume
```

Progress saved in: `./batch-results/.batch-progress.json`

### Cost Tracking

Every file includes cost breakdown:

```json
{
  "fileId": "contract.pdf",
  "success": true,
  "costEstimate": {
    "openai_usd": 0.0003,
    "vision_usd": 0.0015,
    "total_usd": 0.0018
  }
}
```

### Error Handling

Failed files are tracked with detailed errors:

```
   ✗ [5.5%] corrupted.pdf: Failed to parse: Invalid PDF structure
   ⟳ Retrying corrupted.pdf (attempt 2/3)
```

## 🔧 Configuration

### Command-line Options

```bash
npm run batch-process -- \
  --input ./documents \              # Required: input folder
  --operations parse,summarize \     # What to do
  --concurrency 5 \                  # Parallel processing (1-20)
  --chunk-size 100 \                 # Files per chunk (1-200)
  --retry 2 \                        # Retry attempts (0-5)
  --output ./results \               # Output folder
  --resume                           # Resume from previous run
```

### Operations

- **parse** - Extract text with OCR (~$0.0015/page)
- **extract_clauses** - Find contract clauses (~$0.0003/doc)
- **summarize** - Create document summary (~$0.0003/doc)

Combine with commas: `parse,extract_clauses,summarize`

### Summarization Levels

- **quick** - Fast, basic summary (GPT-4o-mini)
- **standard** - Balanced detail (GPT-4o-mini) [default]
- **deep** - Comprehensive analysis (GPT-4o) [10x cost]

## 📈 Performance

### Concurrency Guidelines

| Concurrency | Speed | Cost/min | Best For |
|-------------|-------|----------|----------|
| 1-2 | Slow | Low | Testing |
| 5 (default) | Balanced | Medium | Production |
| 10 | Fast | High | Large batches |
| 15-20 | Very fast | Very high | Rush jobs |

### Time Estimates

Formula: `Time ≈ (Files × 0.5s) / Concurrency`

Examples:
- 1000 files @ concurrency 5 = ~100 seconds
- 4000 files @ concurrency 10 = ~200 seconds

## 💰 Cost Optimization

1. **Skip OCR for digital PDFs** - Save 83% on digital documents
2. **Use quick summaries** - 10x cheaper than deep analysis
3. **Batch in off-peak hours** - Better API response times
4. **Resume interrupted batches** - Don't pay twice
5. **Test with small batches** - Verify before large runs

## 🔗 API Integration

### Direct HTTP API

```bash
# Single file (JSON response)
curl -X POST http://localhost:3000/api/tools/batch_process_documents \
  -H "Authorization: Bearer $SECONDLAYER_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "arguments": {
      "files": [{"id": "doc1", "filename": "contract.pdf", "fileBase64": "..."}],
      "operations": {"parse": true},
      "concurrency": 5
    }
  }'
```

### SSE Streaming

```bash
# With real-time progress (SSE)
curl -N -X POST http://localhost:3000/api/tools/batch_process_documents/stream \
  -H "Authorization: Bearer $SECONDLAYER_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "arguments": {
      "files": [...],
      "operations": {"parse": true, "summarize": true}
    }
  }'
```

## 🐛 Troubleshooting

### Common Issues

**"Insufficient credits"**
```bash
# Check balance
curl -H "Authorization: Bearer $SECONDLAYER_API_KEY" \
  http://localhost:3000/api/billing/balance
```

**"Connection refused"**
```bash
# Ensure backend is running
cd mcp_backend && npm run dev:http
```

**Slow processing**
```bash
# Increase concurrency
npm run batch-process -- --input ./docs --concurrency 15
```

**Memory issues**
```bash
# Reduce chunk size
npm run batch-process -- --input ./docs --chunk-size 50
```

See full troubleshooting guide: [docs/BATCH_PROCESSING_GUIDE.md#troubleshooting](./docs/BATCH_PROCESSING_GUIDE.md#troubleshooting)

## 📚 Documentation

- **[Quick Start](./BATCH_PROCESSING_QUICKSTART.md)** - Get started in 5 minutes
- **[Complete Guide](./docs/BATCH_PROCESSING_GUIDE.md)** - Full documentation
- **[Examples](./examples/batch-processing-examples.sh)** - Real-world scenarios
- **[API Reference](./docs/BATCH_PROCESSING_GUIDE.md#api-reference)** - Detailed API docs

## 🎓 Examples

Run the examples script to see all scenarios:

```bash
./examples/batch-processing-examples.sh
```

Or view inline:

```bash
# 1. Process 4000 images
npm run batch-process -- --input ./images --operations parse --concurrency 10

# 2. Analyze 1000 PDFs
npm run batch-process -- --input ./pdfs --operations parse,summarize --concurrency 5

# 3. Full contract analysis
npm run batch-process -- --input ./contracts --operations parse,extract_clauses,summarize

# 4. Quick test
npm run batch-process -- --input ./test --operations parse --chunk-size 10

# 5. Deep analysis
npm run batch-process -- --input ./important --summarize-level deep
```

## 🧪 Testing

Before processing thousands of files, test with a small batch:

```bash
# Create test directory
mkdir -p test-docs
cp path/to/sample/*.pdf test-docs/

# Test batch processing
npm run batch-process -- \
  --input ./test-docs \
  --operations parse,summarize \
  --concurrency 2

# Check results
ls -lh ./batch-results/
```

## 🚦 Next Steps

1. ✅ Install dependencies: `npm run install:all`
2. ✅ Configure environment: Set `SECONDLAYER_API_KEY`
3. ✅ Start backend: `cd mcp_backend && npm run dev:http`
4. ✅ Test with small batch: 10-50 files
5. ✅ Scale to full batch: 1000+ files
6. ✅ Monitor progress in terminal
7. ✅ Review results in `./batch-results/`

## 📞 Support

- **Issues**: Backend logs at `cd mcp_backend && npm run dev:http`
- **Questions**: See [Troubleshooting Guide](./docs/BATCH_PROCESSING_GUIDE.md#troubleshooting)
- **Bugs**: Check logs and error messages

## 📝 License

MIT License - See [LICENSE](./LICENSE)

---

**Ready to process thousands of documents? Start with the [Quick Start Guide](./BATCH_PROCESSING_QUICKSTART.md)!** 🚀
