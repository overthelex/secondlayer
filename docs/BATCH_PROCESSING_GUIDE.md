# Batch Document Processing Guide

Complete guide for processing thousands of documents (PDF, images, DOCX) with SecondLayer MCP using Cursor IDE.

## 📋 Table of Contents

- [Quick Start](#quick-start)
- [Features](#features)
- [Installation](#installation)
- [Usage Examples](#usage-examples)
- [Configuration](#configuration)
- [Cost Estimation](#cost-estimation)
- [Performance Tuning](#performance-tuning)
- [Troubleshooting](#troubleshooting)
- [API Reference](#api-reference)

## 🚀 Quick Start

### 1. Install dependencies

```bash
cd /home/vovkes/SecondLayer
npm run install:all
```

### 2. Set up environment

```bash
# .env file
SECONDLAYER_API_URL=http://localhost:3000
SECONDLAYER_API_KEY=your-api-key-here

# Or export directly
export SECONDLAYER_API_KEY=your-api-key-here
```

### 3. Run batch processing

```bash
# Basic usage - parse and summarize all documents in a folder
npm run batch-process -- --input ./documents --operations parse,summarize

# Advanced usage - extract clauses from contracts with high concurrency
npm run batch-process -- \
  --input ./contracts \
  --operations parse,extract_clauses,summarize \
  --concurrency 10 \
  --summarize-level deep
```

## ✨ Features

### Real-time Progress Tracking

- **SSE Streaming**: See progress updates as files are processed
- **Live Statistics**: Completed/failed counts, cost tracking, time elapsed
- **File-level Status**: Individual file success/failure with error messages
- **Resume Support**: Continue from where you left off if interrupted

### Batch Operations

1. **parse** - Extract text from documents using OCR (Google Vision API)
   - Supports: PDF, PNG, JPG, JPEG, DOCX
   - Best for: Scanned documents, images with text
   - Cost: ~$0.0015 per page

2. **extract_clauses** - Extract key clauses from contracts
   - Identifies: Parties, rights, obligations, terms, payments, penalties
   - Risk analysis: Highlights high-risk clauses
   - Best for: Legal contracts and agreements
   - Cost: ~$0.0003 per document (GPT-4o-mini)

3. **summarize** - Create document summaries
   - Levels: quick, standard, deep
   - Includes: Executive summary, key facts (parties, dates, amounts)
   - Best for: Quick document understanding
   - Cost: ~$0.0003 (standard), ~$0.005 (deep with GPT-4o)

### Smart Processing

- **Concurrency Control**: Process 1-20 files in parallel
- **Automatic Retry**: Configurable retry logic for failed files
- **Chunking**: Split large batches (1000+ files) into manageable chunks
- **Cost Tracking**: Real-time cost estimation and tracking
- **Error Handling**: Continue processing even if individual files fail

## 📦 Installation

### Prerequisites

- Node.js 20+
- SecondLayer MCP backend running (see [DEPLOYMENT.md](./DEPLOYMENT.md))
- Google Vision API credentials (for OCR)
- Valid API key or JWT token

### Install Script Dependencies

```bash
npm install
```

Dependencies:
- `chalk` - Terminal colors and formatting
- `commander` - CLI argument parsing
- `ora` - Loading spinners
- `cli-table3` - Pretty tables for reports
- `tsx` - TypeScript execution

## 💡 Usage Examples

### Example 1: Parse 4000 Images

```bash
npm run batch-process -- \
  --input ./scanned-documents \
  --operations parse \
  --concurrency 10 \
  --chunk-size 200 \
  --output ./results
```

**Expected:**
- Time: ~2-4 hours (with concurrency 10)
- Cost: ~$6.00 (4000 × $0.0015)
- Success rate: 95%+

### Example 2: Analyze 1000 PDF Contracts

```bash
npm run batch-process -- \
  --input ./contracts \
  --operations parse,extract_clauses,summarize \
  --concurrency 5 \
  --summarize-level standard \
  --retry 3
```

**Expected:**
- Time: ~1-2 hours (with concurrency 5)
- Cost: ~$2.50 (1000 × $0.0025)
- Success rate: 90%+

### Example 3: Deep Analysis with Resume Support

```bash
# First run (interrupted after 500 files)
npm run batch-process -- \
  --input ./documents \
  --operations parse,summarize \
  --summarize-level deep \
  --resume

# Resume after interruption
npm run batch-process -- \
  --input ./documents \
  --operations parse,summarize \
  --summarize-level deep \
  --resume
```

Resume file: `./batch-results/.batch-progress.json`

### Example 4: Cursor Integration

Create a Cursor task file:

```typescript
// cursor-batch-task.ts
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

async function processFolders() {
  const folders = ['./contracts', './invoices', './reports'];

  for (const folder of folders) {
    console.log(`Processing ${folder}...`);

    const { stdout, stderr } = await execAsync(
      `npm run batch-process -- --input ${folder} --operations parse,summarize`
    );

    console.log(stdout);
    if (stderr) console.error(stderr);
  }
}

processFolders();
```

## ⚙️ Configuration

### Command-line Options

| Option | Description | Default | Range |
|--------|-------------|---------|-------|
| `-i, --input <dir>` | Input directory (required) | - | - |
| `-o, --output <dir>` | Output directory | `./batch-results` | - |
| `--operations <ops>` | Operations to perform | `parse,summarize` | See [Operations](#batch-operations) |
| `--summarize-level <level>` | Summarization detail | `standard` | `quick`, `standard`, `deep` |
| `--concurrency <num>` | Parallel processing | `5` | `1-20` |
| `--chunk-size <num>` | Files per chunk | `100` | `1-200` |
| `--retry <num>` | Retry attempts | `2` | `0-5` |
| `--api-url <url>` | Backend URL | `http://localhost:3000` | - |
| `--api-key <key>` | API key | `$SECONDLAYER_API_KEY` | - |
| `--resume` | Resume from previous run | `false` | - |

### Environment Variables

```bash
# Required
SECONDLAYER_API_KEY=sk-xxx         # API key or JWT token

# Optional
SECONDLAYER_API_URL=http://localhost:3000  # Backend URL
NODE_ENV=production                        # Environment
```

### Backend Configuration

In `mcp_backend/.env`:

```bash
# Google Vision API for OCR
VISION_CREDENTIALS_PATH=/path/to/vision-ocr-credentials.json

# OpenAI for AI analysis
OPENAI_API_KEY=sk-xxx
OPENAI_MODEL_QUICK=gpt-4o-mini
OPENAI_MODEL_STANDARD=gpt-4o-mini
OPENAI_MODEL_DEEP=gpt-4o

# Rate limiting (optional)
RATE_LIMIT_REQUESTS_PER_MINUTE=300
RATE_LIMIT_COST_PER_MINUTE=1.0
```

## 💰 Cost Estimation

### Cost Breakdown

| Operation | Model/Service | Cost per Unit | Typical Usage |
|-----------|---------------|---------------|---------------|
| **OCR (parse)** | Google Vision API | $1.50/1000 images | 1 page ≈ 1 image |
| **Extract Clauses** | GPT-4o-mini | $0.15/1M input + $0.60/1M output | ~2000 tokens |
| **Summarize (standard)** | GPT-4o-mini | $0.15/1M input + $0.60/1M output | ~3000 tokens |
| **Summarize (deep)** | GPT-4o | $2.50/1M input + $10/1M output | ~5000 tokens |

### Example Scenarios

#### Scenario 1: 4000 scanned images → OCR only

```
4000 images × $0.0015 = $6.00
Time: 2-4 hours (concurrency 10)
```

#### Scenario 2: 1000 PDFs → Parse + Summarize

```
1000 pages × $0.0015 (OCR) = $1.50
1000 docs × $0.0003 (summarize) = $0.30
Total: $1.80
Time: 1-2 hours (concurrency 5)
```

#### Scenario 3: 500 contracts → Full analysis

```
500 pages × $0.0015 (OCR) = $0.75
500 docs × $0.0003 (extract clauses) = $0.15
500 docs × $0.0003 (summarize) = $0.15
Total: $1.05
Time: 45-90 min (concurrency 5)
```

### Cost Optimization Tips

1. **Skip OCR for digital PDFs**: If PDFs are digital (not scanned), parse operation may not need OCR
2. **Use quick summaries**: `--summarize-level quick` is 10x cheaper than `deep`
3. **Batch processing**: Larger chunks reduce overhead
4. **Concurrency tuning**: Higher concurrency = faster but more API costs
5. **Resume support**: Don't pay twice for interrupted batches

## 🎯 Performance Tuning

### Concurrency Guidelines

| Concurrency | Speed | Cost/min | Best For |
|-------------|-------|----------|----------|
| 1-2 | Slow | Low | Testing, small batches |
| 5 (default) | Balanced | Medium | Most use cases |
| 10 | Fast | High | Large batches, tight deadlines |
| 15-20 | Very fast | Very high | Emergency processing |

**Formula**: `Total time ≈ (Files × Avg time per file) / Concurrency`

**Example**:
- 1000 files
- 0.5s per file (with OCR)
- Concurrency 10

Time = (1000 × 0.5) / 10 = **50 seconds** (theoretical minimum)

In practice: 1-2 minutes (accounting for overhead)

### Chunk Size Guidelines

| Chunk Size | Memory | Network | Best For |
|------------|--------|---------|----------|
| 50 | Low | Low | Small files (<1MB) |
| 100 (default) | Medium | Medium | Most use cases |
| 200 | High | High | Large files (>5MB) |

**Recommendation**: Start with 100, adjust based on:
- File size (larger files = smaller chunks)
- Network speed (slower network = smaller chunks)
- Available memory (less memory = smaller chunks)

### Retry Strategy

| Retry | Processing Time | Success Rate | Best For |
|-------|-----------------|--------------|----------|
| 0 | Fast | Low | Quick tests |
| 2 (default) | Balanced | Medium | Production |
| 3-5 | Slow | High | Critical documents |

**Retry logic**: Exponential backoff (1s, 2s, 4s, 8s, 10s max)

## 🐛 Troubleshooting

### Common Issues

#### 1. "Insufficient credits" error

**Problem**: Account balance too low

**Solution**:
```bash
# Check balance
curl -H "Authorization: Bearer $SECONDLAYER_API_KEY" \
  http://localhost:3000/api/billing/balance

# Top up
# Use web interface: http://localhost:3000/billing
```

#### 2. "Rate limit exceeded" error

**Problem**: Too many requests per minute

**Solution**:
```bash
# Reduce concurrency
npm run batch-process -- --input ./docs --concurrency 3

# Or wait and retry (automatic with --retry)
```

#### 3. OCR errors for scanned documents

**Problem**: Poor image quality or unsupported format

**Solution**:
- Convert to PNG/JPG at 300 DPI
- Ensure text is readable
- Check Google Vision API quotas

#### 4. Memory issues with large PDFs

**Problem**: Out of memory when processing large files

**Solution**:
```bash
# Reduce chunk size
npm run batch-process -- --chunk-size 50

# Or increase Node.js memory
NODE_OPTIONS="--max-old-space-size=4096" npm run batch-process -- ...
```

#### 5. Resume not working

**Problem**: Progress file not found or corrupted

**Solution**:
```bash
# Check progress file
cat ./batch-results/.batch-progress.json

# Reset if corrupted
rm ./batch-results/.batch-progress.json
npm run batch-process -- --input ./docs --resume
```

### Debug Mode

Enable verbose logging:

```bash
# Set log level
export LOG_LEVEL=debug

# Run with debug output
npm run batch-process -- --input ./docs --operations parse 2>&1 | tee debug.log
```

### Performance Monitoring

Monitor in real-time:

```bash
# Terminal 1: Run batch processing
npm run batch-process -- --input ./docs

# Terminal 2: Monitor backend logs
cd mcp_backend
npm run dev:http

# Terminal 3: Monitor system resources
watch -n 1 "ps aux | grep node"
```

## 📚 API Reference

### Batch Processing Tool

**Endpoint**: `POST /api/tools/batch_process_documents/stream`

**Request**:

```json
{
  "arguments": {
    "files": [
      {
        "id": "doc1.pdf",
        "filename": "contract.pdf",
        "fileBase64": "JVBERi0xLjQK...",
        "mimeType": "application/pdf"
      }
    ],
    "operations": {
      "parse": true,
      "extract_clauses": true,
      "summarize": true,
      "summarize_level": "standard"
    },
    "concurrency": 5,
    "retryAttempts": 2,
    "skipErrors": true
  }
}
```

**Response** (SSE stream):

```
event: connected
data: {"total":100,"operations":{"parse":true},"timestamp":"2024-01-15T10:00:00Z"}

event: progress
data: {"fileId":"doc1.pdf","status":"completed","progress":0.01,"completed":1,"failed":0}

event: progress
data: {"message":"Обробка пакету 1/10","progress":0.1,"completed":10,"failed":0}

event: complete
data: {"total":100,"completed":95,"failed":5,"totalCostUsd":0.15}

event: end
data: {"message":"Stream completed"}
```

### SSE Event Types

| Event | Description | Data Fields |
|-------|-------------|-------------|
| `connected` | Initial connection | `total`, `operations`, `timestamp` |
| `progress` | File or batch progress | `fileId`, `status`, `progress`, `completed`, `failed` |
| `complete` | Processing finished | `total`, `completed`, `failed`, `totalCostUsd` |
| `error` | Processing error | `message`, `error` |
| `end` | Stream closed | `message` |

### File Status Values

- `completed` - File processed successfully
- `failed` - File processing failed
- `retrying` - Retrying after failure

## 🔗 Related Documentation

- [MCP Tools Architecture](./MCP_TOOLS_ARCHITECTURE.md) - Backend architecture
- [Document Analysis Integration](./DOCUMENT_ANALYSIS_INTEGRATION.md) - OCR and AI analysis
- [Client Integration Guide](../mcp_backend/docs/CLIENT_INTEGRATION.md) - HTTP API usage
- [SSE Streaming](../mcp_backend/docs/SSE_STREAMING.md) - Real-time progress streaming

## 📞 Support

For issues or questions:

1. Check [Troubleshooting](#troubleshooting) section
2. Review backend logs: `cd mcp_backend && npm run dev:http`
3. Create issue: https://github.com/anthropics/claude-code/issues

## 📝 License

MIT License - See [LICENSE](../LICENSE) for details
