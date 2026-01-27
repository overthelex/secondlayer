# Document Analysis Service - Deployment Guide

## Architecture

The document analysis feature is deployed as a **separate microservice** to keep the main MCP server lightweight and scalable.

```
┌─────────────────────┐
│   MCP Server        │
│   (stdio mode)      │
│   - Legislation     │
│   - Query planning  │
│   - Citations       │
└──────────┬──────────┘
           │ HTTP (port 3001)
           ↓
┌─────────────────────┐
│ Document Service    │
│ (microservice)      │
│ - DocumentParser    │
│ - Playwright        │
│ - Vision API OCR    │
│ - AI Analysis       │
└─────────────────────┘
```

## Local Development

### Using Docker Compose (Recommended)

```bash
# Start all services (document-service + dependencies)
docker-compose up -d

# Start only document service
docker-compose up -d document-service

# View logs
docker-compose logs -f document-service

# Stop services
docker-compose down
```

### Environment Variables

Add to your `.env` file:

```bash
# Document Analysis Service
DOCUMENT_SERVICE_URL=http://localhost:3001
DOCUMENT_SERVICE_PORT=3001
VISION_CREDENTIALS_PATH=../vision-ocr-credentials.json
```

### Running Locally (Without Docker)

```bash
cd mcp_backend

# Build TypeScript
npm run build

# Start document service
DOCUMENT_SERVICE_PORT=3001 node dist/document-service.js

# In another terminal, start MCP server with service URL
DOCUMENT_SERVICE_URL=http://localhost:3001 node dist/index.js
```

## Production Deployment

### Option 1: Docker Container on VPS

**Build and deploy document service:**

```bash
# Build image
docker build -f mcp_backend/Dockerfile.document-service -t document-service:latest ./mcp_backend

# Run container
docker run -d \
  --name document-service \
  -p 3001:3001 \
  -e OPENAI_API_KEY=${OPENAI_API_KEY} \
  -e OPENAI_MODEL=gpt-4o \
  -e LOG_LEVEL=info \
  -v $(pwd)/vision-ocr-credentials.json:/app/vision-ocr-credentials.json:ro \
  --restart unless-stopped \
  document-service:latest

# Check health
curl http://localhost:3001/health
```

**Main MCP server configuration:**

```bash
export DOCUMENT_SERVICE_URL=http://localhost:3001
# or http://document-service:3001 if using docker network
```

### Option 2: Google Cloud Run (Recommended)

**Why Cloud Run:**
- Auto-scaling to zero (pay only for usage)
- Better performance for Vision API (same cloud)
- Handles large containers (up to 32GB)
- Built-in HTTPS and monitoring

**Deploy to Cloud Run:**

```bash
# Set project
gcloud config set project gen-lang-client-0208700641

# Build and push to Artifact Registry
gcloud builds submit \
  --tag gcr.io/gen-lang-client-0208700641/document-service:latest \
  -f mcp_backend/Dockerfile.document-service \
  ./mcp_backend

# Deploy to Cloud Run
gcloud run deploy document-service \
  --image gcr.io/gen-lang-client-0208700641/document-service:latest \
  --platform managed \
  --region europe-west1 \
  --memory 2Gi \
  --cpu 2 \
  --timeout 300 \
  --max-instances 10 \
  --min-instances 0 \
  --set-env-vars OPENAI_API_KEY=${OPENAI_API_KEY},OPENAI_MODEL=gpt-4o \
  --set-secrets VISION_CREDENTIALS_PATH=vision-ocr-credentials:latest \
  --allow-unauthenticated

# Get service URL
gcloud run services describe document-service --region europe-west1 --format 'value(status.url)'
```

**Main MCP server configuration:**

```bash
export DOCUMENT_SERVICE_URL=https://document-service-xxxxx-ew.a.run.app
```

### Option 3: Separate VPS with Reverse Proxy

**On document service server:**

```bash
# Install Docker
curl -fsSL https://get.docker.com -o get-docker.sh
sh get-docker.sh

# Run service
docker run -d \
  --name document-service \
  -p 127.0.0.1:3001:3001 \
  -e OPENAI_API_KEY=${OPENAI_API_KEY} \
  -v /path/to/vision-ocr-credentials.json:/app/vision-ocr-credentials.json:ro \
  --restart unless-stopped \
  document-service:latest
```

**Nginx reverse proxy:**

```nginx
server {
    listen 80;
    server_name docs.secondlayer.app;

    location / {
        proxy_pass http://127.0.0.1:3001;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_read_timeout 300s;
    }

    # HTTPS setup with certbot
}
```

**Main MCP server:**

```bash
export DOCUMENT_SERVICE_URL=https://docs.secondlayer.app
```

## API Endpoints

Document service exposes the following endpoints:

- `GET /health` - Health check (200 OK when healthy)
- `GET /ready` - Readiness check (includes dependencies)
- `POST /api/parse-document` - Parse PDF/DOCX/HTML
- `POST /api/extract-clauses` - Extract key clauses from contracts
- `POST /api/summarize-document` - Create document summaries
- `POST /api/compare-documents` - Compare document versions

## Monitoring

### Health Checks

```bash
# Basic health
curl http://localhost:3001/health

# Detailed readiness
curl http://localhost:3001/ready
```

### Logs

**Docker:**
```bash
docker logs -f document-service
```

**Cloud Run:**
```bash
gcloud logging read "resource.type=cloud_run_revision AND resource.labels.service_name=document-service" --limit 50
```

## Scaling

### Docker Compose

```bash
# Scale to 3 instances
docker-compose up -d --scale document-service=3

# Use nginx load balancer
```

### Cloud Run

Auto-scales based on:
- CPU utilization
- Request concurrency
- Custom metrics

Configure in Cloud Run console or with `--max-instances` flag.

## Troubleshooting

### Service not responding

```bash
# Check if running
docker ps | grep document-service

# Check logs
docker logs document-service --tail 100

# Restart
docker restart document-service
```

### Vision API errors

```bash
# Verify credentials file
ls -la vision-ocr-credentials.json

# Check permissions
gcloud auth application-default print-access-token

# Test Vision API
curl -X POST \
  -H "Authorization: Bearer $(gcloud auth print-access-token)" \
  https://vision.googleapis.com/v1/images:annotate
```

### Playwright browser issues

```bash
# Reinstall browsers in container
docker exec document-service npx playwright install chromium
docker exec document-service npx playwright install-deps chromium

# Check browser path
docker exec document-service ls -la /root/.cache/ms-playwright
```

### High memory usage

- Increase container memory: `--memory 4Gi`
- Limit concurrent requests: add rate limiting
- Implement request queuing
- Scale horizontally (multiple instances)

## Cost Optimization

### Cloud Run

- Set `--min-instances 0` for auto-scale to zero
- Use `--cpu-throttling` during idle
- Set appropriate `--memory` (start with 2Gi)
- Monitor costs in Google Cloud Console

### API Usage

- Cache parsed documents (implement Redis)
- Use lower detail levels for summaries
- Batch document comparisons
- Implement request throttling

## Security

### API Keys

- Never commit `vision-ocr-credentials.json`
- Use Google Cloud Secret Manager for production
- Rotate OpenAI API keys regularly

### Network

- Use internal network for service-to-service communication
- Enable HTTPS/TLS for external access
- Implement rate limiting
- Add authentication (API keys, OAuth)

### Container

- Run as non-root user (add to Dockerfile)
- Scan images for vulnerabilities
- Keep base images updated
- Limit container capabilities
