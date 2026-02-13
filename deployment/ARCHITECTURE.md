# Deployment Architecture

Visual overview of the SecondLayer deployment architecture.

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
                        |   Staging Services    |
                        |  mail.lexapp.co.ua    |
                        +-----------------------+
```

## Staging Environment (secondlayer-stage-network)
```
+----------------------------------------------------------+
|  Staging Network (secondlayer-stage-network)             |
|                                                          |
|  +-----------+  +-----------+  +-----------+            |
|  |  Frontend |  |  Backend  |  | PostgreSQL|            |
|  | lexwebapp |  |    app    |  |  postgres |            |
|  |  :8092    |  |   :3004   |  |   :5434   |            |
|  +-----------+  +-----------+  +-----------+            |
|       |              |              |                    |
|       +--------------+--------------+                    |
|                      |                                   |
|       +--------------+--------------+                    |
|       |                             |                    |
|  +----v------+           +----------v-------+           |
|  |   Qdrant  |           |      Redis       |           |
|  | :6337-6338|           |      :6381       |           |
|  +-----------+           +------------------+           |
+----------------------------------------------------------+
```

## Request Flow

```
User -> HTTPS:443 -> System Nginx -> Backend:3004 / Frontend:8092
```

## Data Flow

```
Frontend (Browser)
    |
    | HTTPS Request
    v
System Nginx (SSL termination)
    |
    | HTTP (internal)
    v
Backend Node.js App
    |
    +-> PostgreSQL (Metadata & Structured Data)
    |       -> Court cases, patterns, queries
    |
    +-> Qdrant (Vector Embeddings)
    |       -> Semantic search, similarity
    |
    +-> Redis (Cache)
    |       -> Query results, session data
    |
    +-> OpenAI API (External)
    |       -> Embeddings, GPT analysis
    |
    +-> ZakonOnline API (External)
            -> Court document retrieval
```

## Port Matrix

### Staging (mail.lexapp.co.ua)

| Port | Service | Protocol |
|------|---------|----------|
| 3004 | Backend API | HTTP |
| 8092 | Frontend | HTTP |
| 5434 | PostgreSQL | PostgreSQL |
| 6381 | Redis | Redis |
| 6337-6338 | Qdrant | HTTP/gRPC |

### Local (localhost)

| Port | Service | Protocol |
|------|---------|----------|
| 3000 | Backend API | HTTP |
| 5173 | Frontend (Vite) | HTTP |
| 5432 | PostgreSQL | PostgreSQL |
| 6379 | Redis | Redis |
| 6333-6334 | Qdrant | HTTP/gRPC |

## Security Layers

### 1. Network Isolation
- Docker networks per environment
- No inter-environment communication

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

## Resource Allocation (Staging)

```
CPU:     2 cores (reserved: 1)
Memory:  4 GB (reserved: 2 GB)
Redis:   2048 MB (maxmemory + LRU eviction)
```

## Monitoring

- Prometheus: metrics collection
- Grafana: dashboards and alerting
- Health endpoints: `/health`, `/health/live`, `/health/ready`
- Metrics endpoint: `/metrics`

---

**Last Updated**: 2026-02-13
