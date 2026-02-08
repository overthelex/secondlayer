# Batch Processing Quick Start 🚀

Process 4000 images and 1000 PDFs with SecondLayer MCP in under 5 minutes.

## Step 1: Install Dependencies (1 min)

```bash
cd /home/vovkes/SecondLayer
npm run install:all
```

## Step 2: Configure Environment (1 min)

```bash
# Create .env file or export directly
export SECONDLAYER_API_KEY=your-api-key-here
export SECONDLAYER_API_URL=http://localhost:3000  # or https://stage.legal.org.ua
```

## Step 3: Start Backend (30 sec)

```bash
# Terminal 1: Start backend
cd mcp_backend
npm run dev:http
```

Backend should start on http://localhost:3000

## Step 4: Run Batch Processing (2 min setup + processing time)

### Process 4000 Images

```bash
npm run batch-process -- \
  --input ./path/to/4000-images \
  --operations parse \
  --concurrency 10 \
  --output ./image-results
```

**Expected:**
- ⏱️ Time: 2-4 hours
- 💰 Cost: ~$6.00
- 📊 Success: 95%+

### Process 1000 PDFs

```bash
npm run batch-process -- \
  --input ./path/to/1000-pdfs \
  --operations parse,summarize \
  --concurrency 5 \
  --output ./pdf-results
```

**Expected:**
- ⏱️ Time: 1-2 hours
- 💰 Cost: ~$1.80
- 📊 Success: 90%+

### Full Analysis (Parse + Extract + Summarize)

```bash
npm run batch-process -- \
  --input ./contracts \
  --operations parse,extract_clauses,summarize \
  --concurrency 5 \
  --summarize-level standard
```

**Expected:**
- ⏱️ Time: Varies by size
- 💰 Cost: ~$2.50 per 1000 docs
- 📊 Success: 90%+

## Real-time Progress

You'll see live updates in the terminal:

```
📦 SecondLayer Batch Document Processor

✓ Found 4000 files to process

⚙️  Configuration:
   API URL:       http://localhost:3000
   Operations:    parse
   Concurrency:   10
   Chunk size:    100

💰 Cost Estimation:
   Per file:      ~$0.0015
   Total:         ~$6.00

⏱️  Time Estimation:
   Per file:      ~0.5s
   Total:         ~0h 33m

🔄 Processing 4000 files in 40 chunks

📦 Chunk 1/40 (100 files)
   ✓ [0.5%] image001.jpg ($0.0015) 0.4s
   ✓ [1.0%] image002.jpg ($0.0015) 0.5s
   ...
```

## Progress Monitoring in Cursor

In Cursor, you can see the progress in real-time. The script will:

1. ✅ Show connection status
2. 📊 Display progress percentage
3. ✓ Mark completed files (green)
4. ✗ Mark failed files (red)
5. 💰 Track costs in real-time
6. ⏱️ Show time per file

## Resume Support

If processing is interrupted:

```bash
# First run (interrupted)
npm run batch-process -- --input ./docs --operations parse --resume

# Resume later
npm run batch-process -- --input ./docs --operations parse --resume
```

Progress is saved in `./batch-results/.batch-progress.json`

## Options Reference

| Option | Description | Default |
|--------|-------------|---------|
| `--input` | Input folder (required) | - |
| `--operations` | What to do | `parse,summarize` |
| `--concurrency` | Parallel files | `5` |
| `--output` | Results folder | `./batch-results` |
| `--resume` | Continue from last | `false` |

### Operations

- `parse` - Extract text with OCR ($0.0015/page)
- `extract_clauses` - Find key contract clauses ($0.0003/doc)
- `summarize` - Create document summary ($0.0003/doc)

Combine with commas: `parse,extract_clauses,summarize`

## Cost Calculator

| Files | Operations | Concurrency | Time | Cost |
|-------|-----------|-------------|------|------|
| 4000 images | parse | 10 | 2-4h | $6.00 |
| 1000 PDFs | parse,summarize | 5 | 1-2h | $1.80 |
| 500 contracts | parse,extract,summarize | 5 | 45-90m | $1.05 |

## Troubleshooting

### "Insufficient credits" error

```bash
# Check balance
curl -H "Authorization: Bearer $SECONDLAYER_API_KEY" \
  http://localhost:3000/api/billing/balance

# Top up via web interface
```

### "Connection refused" error

Make sure backend is running:

```bash
cd mcp_backend
npm run dev:http
```

### Slow processing

Increase concurrency (up to 20):

```bash
npm run batch-process -- --input ./docs --concurrency 15
```

### Memory issues

Reduce chunk size:

```bash
npm run batch-process -- --input ./docs --chunk-size 50
```

## Next Steps

- 📚 Read full guide: [docs/BATCH_PROCESSING_GUIDE.md](./docs/BATCH_PROCESSING_GUIDE.md)
- 🔧 API Reference: [docs/MCP_TOOLS_ARCHITECTURE.md](./docs/MCP_TOOLS_ARCHITECTURE.md)
- 💡 Examples: See [Usage Examples](./docs/BATCH_PROCESSING_GUIDE.md#usage-examples)

## Support

Questions? Check:
1. [Troubleshooting Guide](./docs/BATCH_PROCESSING_GUIDE.md#troubleshooting)
2. Backend logs: `cd mcp_backend && npm run dev:http`
3. GitHub issues: https://github.com/your-repo/issues

---

**Ready to process thousands of documents? Run the command above! 🚀**
