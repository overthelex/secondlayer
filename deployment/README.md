# SecondLayer Deployment

Deployment configuration for the SecondLayer legal tech platform.

## Environments

| Environment | Server | URL |
|------------|--------|-----|
| **Staging** | mail.lexapp.co.ua | `https://stage.legal.org.ua/` |
| **Local** | localhost | `https://localdev.legal.org.ua/` |

## Quick Start

### Local Development

```bash
cd deployment
cp .env.local.example .env.local   # Configure environment variables
./manage-gateway.sh start local    # Start local environment
```

See [`LOCAL_DEVELOPMENT.md`](./LOCAL_DEVELOPMENT.md) for detailed setup.

### Stage Deployment

```bash
cd deployment
./manage-gateway.sh deploy stage   # Deploy to mail.lexapp.co.ua
```

## Management Commands

```bash
./manage-gateway.sh start <env>     # Start environment (stage|local)
./manage-gateway.sh stop <env>      # Stop environment
./manage-gateway.sh restart <env>   # Restart environment
./manage-gateway.sh deploy <env>    # Deploy environment (stage|local)
./manage-gateway.sh status          # Show status of all containers
./manage-gateway.sh health          # Check health of all services
./manage-gateway.sh logs <env>      # View logs (stage|local|gateway)
./manage-gateway.sh build           # Build Docker images
./manage-gateway.sh gateway start   # Start nginx gateway
./manage-gateway.sh clean stage     # Clean environment data
```

## Files

```
deployment/
├── manage-gateway.sh                # Main management script
├── docker-compose.local.yml         # Local development
├── docker-compose.stage.yml         # Staging environment
├── docker-compose.gateway.yml       # Nginx gateway proxy
├── nginx-gateway.conf               # Gateway routing config (stage)
├── nginx-stage.legal.org.ua.conf    # System nginx config for stage
├── nginx-stage-mcp.conf             # MCP SSE nginx config
├── Dockerfile.mono-backend          # Backend Docker image
├── Dockerfile.mono-rada             # RADA MCP Docker image
├── Dockerfile.mono-openreyestr      # OpenReyestr Docker image
├── Dockerfile.document-service      # Document service Docker image
├── .env.local.example               # Local env template
├── .env.stage (gitignored)          # Stage env vars
├── .env.local (gitignored)          # Local env vars
├── lib/                             # Deploy orchestration scripts
├── docker/                          # DB init scripts
├── nginx/                           # Nginx configs for local
├── prometheus/                      # Prometheus configs
└── grafana/                         # Grafana provisioning
```

## Documentation

| Document | Description |
|----------|-------------|
| [`LOCAL_DEVELOPMENT.md`](./LOCAL_DEVELOPMENT.md) | Local dev setup guide |
| [`GATEWAY_SETUP.md`](./GATEWAY_SETUP.md) | Stage deployment guide |
| [`ARCHITECTURE.md`](./ARCHITECTURE.md) | System architecture |
| [`TESTING.md`](./TESTING.md) | Testing guide |
| [`CREDENTIALS_SETUP.md`](./CREDENTIALS_SETUP.md) | Credentials setup |
| [`QUICK_START.md`](./QUICK_START.md) | Quick start guide |
