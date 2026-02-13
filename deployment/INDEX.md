
# Deployment Files Index

Complete index of all deployment files.

## Quick Navigation

- **Local Development**: [`LOCAL_DEVELOPMENT.md`](./LOCAL_DEVELOPMENT.md) - Start here for local development
- **Testing**: [`TESTING.md`](./TESTING.md) - Run tests for local deployment
- **Getting Started**: [`QUICK_START.md`](./QUICK_START.md) - Deploy to remote servers
- **Full Documentation**: [`GATEWAY_SETUP.md`](./GATEWAY_SETUP.md) - Complete setup guide
- **Architecture**: [`ARCHITECTURE.md`](./ARCHITECTURE.md) - System architecture

## Docker Compose Files

| File | Purpose | Location |
|------|---------|----------|
| [`docker-compose.local.yml`](./docker-compose.local.yml) | Local development | Your machine |
| [`docker-compose.stage.yml`](./docker-compose.stage.yml) | Staging environment | mail.lexapp.co.ua |
| [`docker-compose.gateway.yml`](./docker-compose.gateway.yml) | Nginx gateway proxy | Stage server |

## Configuration Files

### Nginx Configuration
- [`nginx-gateway.conf`](./nginx-gateway.conf) - Gateway routing for stage environment
- [`nginx-stage.legal.org.ua.conf`](./nginx-stage.legal.org.ua.conf) - System nginx config for stage
- [`nginx-stage-mcp.conf`](./nginx-stage-mcp.conf) - MCP SSE nginx config

### Environment Variables (Templates)
- [`.env.local.example`](./.env.local.example) - Local development variables template

**Warning**: Copy `.env.*.example` to `.env.*` and fill in real values before starting.

## Scripts

### Management Script
- [`manage-gateway.sh`](./manage-gateway.sh) - Main deployment management script

**Capabilities**:
- Start/stop/restart environments (stage, local)
- View status and logs
- Deploy to stage server (mail.lexapp.co.ua)
- Build Docker images
- Gateway management
- Health checks

**Usage**:
```bash
./manage-gateway.sh <command> [environment]
```

See `./manage-gateway.sh` (no arguments) for full help.

## Documentation

| Document | Description | Audience |
|----------|-------------|----------|
| [`LOCAL_DEVELOPMENT.md`](./LOCAL_DEVELOPMENT.md) | Local dev setup guide | Developers |
| [`TESTING.md`](./TESTING.md) | Testing guide | Developers/QA |
| [`QUICK_START.md`](./QUICK_START.md) | Gateway deployment guide | DevOps |
| [`GATEWAY_SETUP.md`](./GATEWAY_SETUP.md) | Complete setup guide | DevOps |
| [`ARCHITECTURE.md`](./ARCHITECTURE.md) | Architecture details | Technical team |
| [`CREDENTIALS_SETUP.md`](./CREDENTIALS_SETUP.md) | Credentials setup | DevOps |
| [`INDEX.md`](./INDEX.md) | This file | Everyone |
| [`README.md`](./README.md) | Overview | Everyone |

## Port Reference

| Environment | Backend | Frontend | PostgreSQL | Redis | Qdrant |
|------------|---------|----------|------------|-------|---------|
| **Local** | 3000 | 5173 | 5432 | 6379 | 6333-6334 |
| **Staging** | 3004 | 8092 | 5434 | 6381 | 6337-6338 |

## URL Structure

```
https://localdev.legal.org.ua        -> Local (your machine)
https://stage.legal.org.ua           -> Staging (mail.lexapp.co.ua)
```

## File Structure

```
deployment/
├── docker-compose.local.yml         # Local development
├── docker-compose.stage.yml         # Staging (mail.lexapp.co.ua)
├── docker-compose.gateway.yml       # Nginx gateway (stage server)
├── nginx-gateway.conf               # Nginx gateway routing config
├── nginx-stage.legal.org.ua.conf    # System nginx for stage
├── nginx-stage-mcp.conf             # MCP SSE nginx config
├── .env.local.example               # Local env template
├── .env.local                       # Actual local env (gitignored)
├── .env.stage                       # Actual stage env (gitignored)
├── manage-gateway.sh                # Management script
├── lib/                             # Deploy orchestration scripts
├── docker/                          # DB init scripts
├── nginx/                           # Nginx configs for local
├── prometheus/                      # Prometheus configs
├── grafana/                         # Grafana provisioning
├── LOCAL_DEVELOPMENT.md             # Local dev guide
├── TESTING.md                       # Testing guide
├── QUICK_START.md                   # Gateway deployment guide
├── GATEWAY_SETUP.md                 # Complete documentation
├── ARCHITECTURE.md                  # Architecture details
├── CREDENTIALS_SETUP.md             # Credentials setup
├── INDEX.md                         # This file
└── README.md                        # Overview
```

## Common Commands

```bash
# Local development
./manage-gateway.sh start local      # Start local environment
./manage-gateway.sh stop local       # Stop local environment
./manage-gateway.sh logs local       # View local logs

# Staging
./manage-gateway.sh start stage      # Start staging
./manage-gateway.sh stop stage       # Stop staging
./manage-gateway.sh logs stage       # View staging logs

# Management
./manage-gateway.sh status           # View status of all containers
./manage-gateway.sh health           # Check health of all services

# Deploy to stage server
./manage-gateway.sh deploy stage     # Deploy stage to mail.lexapp.co.ua

# Gateway operations
./manage-gateway.sh gateway start    # Start nginx gateway
./manage-gateway.sh gateway restart  # Restart nginx gateway
./manage-gateway.sh gateway test     # Test nginx configuration
```

## Getting Started Checklist

**For Local Development** (developers):
- [ ] Read [`LOCAL_DEVELOPMENT.md`](./LOCAL_DEVELOPMENT.md)
- [ ] Copy `.env.local.example` to `.env.local`
- [ ] Add OpenAI and ZakonOnline API keys
- [ ] Run `./manage-gateway.sh start local`
- [ ] Access https://localdev.legal.org.ua

**For Stage Deployment** (DevOps):
- [ ] Read [`QUICK_START.md`](./QUICK_START.md)
- [ ] Configure `.env.stage`
- [ ] Run `./manage-gateway.sh deploy stage`

---

**Generated**: 2026-02-13
