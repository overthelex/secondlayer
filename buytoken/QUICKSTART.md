# Quick Start - Deploy to Gate Server

## TL;DR

```bash
# 1. Create .env file with your credentials
cd /Users/vovkes/ZOMCP/SecondLayer/buytoken
cp .env.example .env
# Edit .env with your values

# 2. Run deployment script
./deploy-to-gate.sh

# 3. Done! Visit https://legal.org.ua/console
```

## What Gets Deployed

- **URL**: https://legal.org.ua/console
- **Server**: gate.lexapp.co.ua
- **Components**:
  - Frontend (HTML/CSS/JS) - User interface
  - Backend (Node.js) - API server with OAuth
  - Database (PostgreSQL) - User data and payments
  - Nginx - Reverse proxy on gate server

## Environment Variables (Required)

Create `.env` file:

```bash
JWT_SECRET=your-random-32-char-secret-here
GOOGLE_CLIENT_ID=your-google-oauth-client-id
GOOGLE_CLIENT_SECRET=your-google-oauth-secret
SMTP_USER=secondlayermcp@legal.org.ua
SMTP_PASS=your-email-password
```

## One-Command Deploy

```bash
./deploy-to-gate.sh
```

This script will:
1. Build Docker images
2. Copy files to gate server
3. Configure nginx
4. Start containers
5. Verify deployment

## Manual Deploy (3 Steps)

If automated script fails:

```bash
# Step 1: Copy files
rsync -avz . vovkes@gate.lexapp.co.ua:/opt/secondlayer-console/

# Step 2: SSH and configure
ssh vovkes@gate.lexapp.co.ua
cd /opt/secondlayer-console
sudo cp nginx-gate-server.conf /etc/nginx/sites-available/legal.org.ua-console
sudo ln -s /etc/nginx/sites-available/legal.org.ua-console /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx

# Step 3: Start Docker
docker-compose -f docker-compose.gate-server.yml up -d --build
```

## Verify Deployment

```bash
# Local health check
curl http://localhost:8080/health

# Public access
curl https://legal.org.ua/console

# Check logs
docker-compose -f docker-compose.gate-server.yml logs -f
```

## Common Issues

### 502 Bad Gateway
→ Container not running: `docker ps | grep secondlayer`

### Port 8080 in use
→ Check: `lsof -i :8080`

### OAuth redirect error
→ Update Google Console callback: `https://legal.org.ua/console/api/auth/google/callback`

## Useful Commands

```bash
# View logs
ssh vovkes@gate.lexapp.co.ua 'cd /opt/secondlayer-console && docker-compose -f docker-compose.gate-server.yml logs -f'

# Restart
ssh vovkes@gate.lexapp.co.ua 'cd /opt/secondlayer-console && docker-compose -f docker-compose.gate-server.yml restart'

# Stop
ssh vovkes@gate.lexapp.co.ua 'cd /opt/secondlayer-console && docker-compose -f docker-compose.gate-server.yml down'
```

## Need Help?

See full documentation: [DEPLOYMENT.md](./DEPLOYMENT.md)
