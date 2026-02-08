# 2-Environment Gateway Architecture

Visual overview of the SecondLayer 2-environment gateway deployment.

## Network Architecture

```
                                  Internet
                                     |
                                     v
                        +-----------------------+
                        |  stage.legal.org.ua   |
                        |   (System Nginx SSL)  |
                        +-----------------------+
                                     |
                                     v
                        +-----------------------+
                        | legal-nginx-gateway   |
                        |    (Port 8080)        |
                        |   Path-based Routing  |
                        +-----------------------+
                                     |
                        +------------+------------+
                        |                         |
                        v                         v
                 +-------------+           +-------------+
                 |   Staging   |           | Development |
                 |  /staging   |           |/development |
                 +-------------+           +-------------+
```

## Environment Isolation

Each environment runs in its own isolated Docker network:

### Staging Environment (secondlayer-stage-network)
```
+----------------------------------------------------------+
|  Staging Network (secondlayer-stage-network)             |
|                                                          |
|  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐    |
|  │   Frontend  │  │   Backend   │  │  PostgreSQL │    |
|  │ lexwebapp   │  │     app     │  │   postgres  │    |
|  │  :8092      │  │   :3004     │  │   :5434     │    |
|  └─────────────┘  └─────────────┘  └─────────────┘    |
|         │                │                 │            |
|         └────────────────┴─────────────────┘            |
|                          │                              |
|         ┌────────────────┴────────────────┐             |
|         │                                 │             |
|  ┌──────▼──────┐              ┌──────────▼──────┐     |
|  │   Qdrant    │              │      Redis       │     |
|  │  :6337-6338 │              │      :6381       │     |
|  └─────────────┘              └──────────────────┘     |
+----------------------------------------------------------+
```

### Development Environment (secondlayer-dev-network)
```
+----------------------------------------------------------+
|  Development Network (secondlayer-dev-network)           |
|                                                          |
|  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐    |
|  │   Frontend  │  │   Backend   │  │  PostgreSQL │    |
|  │ lexwebapp   │  │     app     │  │   postgres  │    |
|  │  :8091      │  │   :3003     │  │   :5433     │    |
|  └─────────────┘  └─────────────┘  └─────────────┘    |
|         │                │                 │            |
|         └────────────────┴─────────────────┘            |
|                          │                              |
|         ┌────────────────┴────────────────┐             |
|         │                                 │             |
|  ┌──────▼──────┐              ┌──────────▼──────┐     |
|  │   Qdrant    │              │      Redis       │     |
|  │  :6335-6336 │              │      :6380       │     |
|  └─────────────┘              └──────────────────┘     |
+----------------------------------------------------------+
```

## Request Flow

### Staging Request
```
User → HTTPS:443 → System Nginx → Gateway:8080
                                      ↓
                                 /staging/*
                                      ↓
                     ┌────────────────┴────────────────┐
                     ↓                                 ↓
              Frontend:8092                      Backend:3004
              (HTML/CSS/JS)                  (API /staging/api/*)
```

### Development Request
```
User → HTTPS:443 → System Nginx → Gateway:8080
                                      ↓
                              /development/*
                                      ↓
                     ┌────────────────┴────────────────┐
                     ↓                                 ↓
              Frontend:8091                      Backend:3003
              (HTML/CSS/JS)              (API /development/api/*)
```

## Data Flow

### Backend Processing
```
Frontend (Browser)
    │
    │ HTTPS Request
    ↓
Gateway Nginx
    │
    │ HTTP (internal)
    ↓
Backend Node.js App
    │
    ├─→ PostgreSQL (Metadata & Structured Data)
    │       └─→ Court cases, patterns, queries
    │
    ├─→ Qdrant (Vector Embeddings)
    │       └─→ Semantic search, similarity
    │
    ├─→ Redis (Cache)
    │       └─→ Query results, session data
    │
    ├─→ OpenAI API (External)
    │       └─→ Embeddings, GPT analysis
    │
    └─→ ZakonOnline API (External)
            └─→ Court document retrieval
```

## Port Matrix

### Host Ports (Exposed)

| Port | Service | Environment | Protocol |
|------|---------|-------------|----------|
| 8080 | Gateway Nginx | All | HTTP |
| 3004 | Backend API | Staging | HTTP |
| 3003 | Backend API | Development | HTTP |
| 8092 | Frontend | Staging | HTTP |
| 8091 | Frontend | Development | HTTP |
| 5434 | PostgreSQL | Staging | PostgreSQL |
| 5433 | PostgreSQL | Development | PostgreSQL |
| 6381 | Redis | Staging | Redis |
| 6380 | Redis | Development | Redis |
| 6337-6338 | Qdrant | Staging | HTTP/gRPC |
| 6335-6336 | Qdrant | Development | HTTP/gRPC |

### Internal Ports (Within Docker Networks)

All containers communicate on standard internal ports:
- Backend: `3004`, `3003` (same as host)
- Frontend: `80` (nginx inside container)
- PostgreSQL: `5432` (mapped to different host ports)
- Redis: `6379` (mapped to different host ports)
- Qdrant: `6333-6334` (mapped to different host ports)

## Container Dependencies

### Dependency Graph
```
Staging:
    app-stage
        ├── depends_on: postgres-stage (healthy)
        ├── depends_on: qdrant-stage (started)
        └── depends_on: redis-stage (healthy)

    lexwebapp-stage
        └── (independent, no dependencies)

Development:
    app-dev
        ├── depends_on: postgres-dev (healthy)
        ├── depends_on: qdrant-dev (started)
        └── depends_on: redis-dev (healthy)

    lexwebapp-dev
        └── (independent, no dependencies)

Gateway:
    nginx-gateway
        └── (independent, routes to all environments)
```

## Security Layers

### 1. Network Isolation
- Each environment in separate Docker network
- No inter-environment communication
- Gateway can reach all via `host.docker.internal`

### 2. Authentication
- JWT tokens for user sessions
- API keys for HTTP API access (`SECONDARY_LAYER_KEYS`)
- Google OAuth2 for user login

### 3. SSL/TLS
- System Nginx handles SSL termination
- Internal communication via HTTP (within server)

### 4. Database Security
- Separate databases per environment
- Strong passwords
- No external access (only via Docker network)

## Resource Allocation

### CPU Limits
```
Staging:      1.5 cores (reserved: 0.75)
Development:  1.0 core  (reserved: 0.5)
```

### Memory Limits
```
Staging:      3 GB (reserved: 1.5 GB)
Development:  2 GB (reserved: 1 GB)
```

### Redis Memory
```
Staging:      1.5 GB (maxmemory + LRU eviction)
Development:  1 GB (maxmemory + LRU eviction)
```

## Scaling Considerations

### Vertical Scaling
Adjust resource limits in `docker-compose.*.yml`:

```yaml
deploy:
  resources:
    limits:
      cpus: '4.0'
      memory: 8G
```

### Database Scaling
Consider:
- PostgreSQL replication (master-slave)
- Qdrant clustering
- Redis Sentinel for HA

## Monitoring Points

### Health Checks
- `/health` endpoints on each backend
- Container health checks (Docker)
- Database connection checks
- External API availability

### Metrics to Monitor
- Request latency per environment
- Database query performance
- Cache hit rates
- Resource utilization (CPU, memory, disk)
- API quota usage (OpenAI, ZakonOnline)

### Logging
- Application logs: `../mcp_backend/logs/`
- Container logs: `docker logs <container>`
- Nginx access/error logs: Gateway container volumes

## Disaster Recovery

### Backup Points
1. PostgreSQL databases (daily)
2. Qdrant vector storage (weekly)
3. Environment configurations (.env files)
4. Docker volumes (as needed)

### Recovery Procedure
1. Stop affected environment
2. Restore database from backup
3. Restore vector storage
4. Restart environment
5. Verify health

---

**Architecture Version**: 2.0.0
**Last Updated**: 2026-02-08
