
# SecondLayer Deployment Summary
## Current Deployment System
### Active Environments

- **Development**: `https://dev.legal.org.ua/`
- **Production**: `https://legal.org.ua/`
- **Staging**: `https://stage.legal.org.ua/`
### Current Scripts

- `deploy-to-gate.sh` - Main production deployment
- `deploy-local.sh` - Local development setup
### Current Documentation

- `deployment/` - Complete gateway system documentation
- `QUICK_REFERENCE.md` - Production URLs and commands
### Gateway Management

All environments are managed through the gateway system:

```bash
cd deployment
./manage-gateway.sh <command> <environment>
```
## Quick Commands
### Production Deployment

```bash
./deploy-to-gate.sh
```
### Local Development

```bash
./deploy-local.sh
```
### Gateway Management

```bash
cd deployment
./manage-gateway.sh status
./manage-gateway.sh deploy all
```
## Documentation Index

- `deployment/INDEX.md` - Complete file index
- `deployment/QUICK_START.md` - Gateway deployment guide
- `deployment/GATEWAY_SETUP.md` - Complete setup guide
