# Quick Start Guide - 2-Environment Gateway

Fast setup guide for SecondLayer 2-environment gateway (stage + dev).

## Prerequisites

- Docker and Docker Compose installed
- SSH access to gate/mail servers (for remote deployment)
- API keys: OpenAI, ZakonOnline, Google OAuth

## 5-Minute Local Setup

### 1. Configure Environment

```bash
cd deployment

# Copy and edit environment files
cp .env.stage.example .env.stage
cp .env.dev.example .env.dev

# Edit each file with your API keys
nano .env.stage
nano .env.dev
```

**Required fields in each `.env.*` file:**
- `POSTGRES_PASSWORD` - Database password
- `JWT_SECRET` - Random 64-char string
- `OPENAI_API_KEY` - Your OpenAI key
- `ZAKONONLINE_API_TOKEN` - Your ZO token
- `SECONDARY_LAYER_KEYS` - API keys for HTTP auth
- `GOOGLE_CLIENT_ID` & `GOOGLE_CLIENT_SECRET` - OAuth

### 2. Build and Start

```bash
# Build Docker images
./manage-gateway.sh build

# Start all environments
./manage-gateway.sh start all

# Start nginx gateway
./manage-gateway.sh gateway start
```

### 3. Verify

```bash
# Check status
./manage-gateway.sh status

# Check health
./manage-gateway.sh health
```

**Access URLs:**
- Staging: http://localhost:8080/staging/
- Development: http://localhost:8080/development/

## Common Commands

```bash
# Start/Stop/Restart
./manage-gateway.sh start stage
./manage-gateway.sh stop dev
./manage-gateway.sh restart stage

# View logs
./manage-gateway.sh logs stage

# Check status
./manage-gateway.sh status

# Deploy to remote server
./manage-gateway.sh deploy stage
```

## Port Reference

| Service | Stage | Dev |
|---------|-------|-----|
| Backend | 3004 | 3003 |
| Frontend | 8092 | 8091 |
| PostgreSQL | 5434 | 5433 |
| Redis | 6381 | 6380 |
| Qdrant | 6337 | 6335 |

**Gateway**: 8080

## Troubleshooting

### Health check fails
```bash
# Check if containers are running
./manage-gateway.sh status

# View logs
./manage-gateway.sh logs stage

# Restart environment
./manage-gateway.sh restart stage
```

### Port already in use
```bash
# Find what's using the port
sudo lsof -i :3004

# Kill the process or change port in docker-compose
```

### Database connection error
```bash
# Check PostgreSQL is running
docker ps | grep postgres

# View PostgreSQL logs
docker logs secondlayer-postgres-stage
```

## Next Steps

- Read full documentation: `GATEWAY_SETUP.md`
- Configure SSL: Set up Let's Encrypt on servers
- Set up monitoring: Configure health check alerts
- Database backups: Schedule automated backups

## Support

For detailed documentation, see `GATEWAY_SETUP.md`
