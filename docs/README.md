# SecondLayer Documentation

Complete documentation for SecondLayer legal analysis platform - Ukrainian legal tech platform with AI-powered document analysis, semantic search, and MCP integration.

## 🚀 Quick Start

- **[START_HERE](guides/START_HERE.md)** - Getting started guide ⭐
- [QUICK_REFERENCE](guides/QUICK_REFERENCE.md) - Quick reference for common tasks
- [QUICK_START](guides/QUICK_START.md) - Quick start guide

## 🔗 Client Integration

- **[MCP Client Integration Guide](MCP_CLIENT_INTEGRATION_GUIDE.md) - Complete guide for connecting 10+ LLM clients** ⭐
  - Desktop clients: Claude Desktop, Jan AI, Cherry Studio, Chat-MCP, BoltAI
  - Web clients: LibreChat, AnythingLLM, Open WebUI, Chainlit, ChatGPT Web
  - All transport protocols (stdio, HTTP, SSE, Streamable HTTP)
  - Complete configurations, examples, and troubleshooting

## 🏛️ Backend Services

### MCP Backend (Court Cases & Documents) - 36 Tools
- **[Backend README](backend/README.md)** - Main backend documentation
- [Client Integration](backend/CLIENT_INTEGRATION.md) - How to integrate with backend
- **[SSE Streaming](backend/SSE_STREAMING.md)** - Server-Sent Events streaming guide
- [Remote MCP Deployment](backend/REMOTE_MCP_DEPLOYMENT.md) - Remote MCP server deployment
- [Config Examples](backend/config-examples/) - Configuration examples

### MCP Rada (Parliament Data) - 4 Tools
- [Rada README](rada/README.md) - Parliament data service documentation

### MCP OpenReyestr (Open Registries) - 5 Tools
- [OpenReyestr README](openreyestr/README.md) - Open registries service
- [Quickstart](openreyestr/QUICKSTART.md) - Quick start guide
- [Database Setup](openreyestr/DATABASE_SETUP.md) - Database configuration
- [Docker Guide](openreyestr/DOCKER_GUIDE.md) - Docker deployment

## 🚀 Deployment

- [Docker Deployment](../deployment/README.md) - Docker deployment guide
- [Local Development](../deployment/LOCAL_DEVELOPMENT.md) - Local development setup
- [Gateway Setup](../deployment/GATEWAY_SETUP.md) - Multi-environment gateway configuration

## 📚 API Documentation

- **[ALL MCP TOOLS](ALL_MCP_TOOLS.md) - Complete list of all 45 MCP tools** ⭐
- [MCP Tools Schema](api/MCP_TOOLS_SCHEMA.json) - JSON schema for MCP tools
- [MCP Tools Summary](api/MCP_TOOLS_SUMMARY.md) - Tools summary
- [MCP Client Config](api/MCP_CLIENT_CONFIG.md) - Client configuration

## 🧪 Testing

- [Quick Testing](../tests/README.md) - Test framework overview
- [E2E Testing](../tests/e2e/) - Playwright end-to-end tests

## 🔒 Security

- [Security Overview](security/SECURITY.md) - Security best practices
- [CSP Configuration](security/CSP_CONFIGURATION.md) - Content Security Policy

## 📖 Guides

- [Quick Start Guide](guides/QUICK_START_GUIDE.md) - Detailed quick start
- [Model Selection Guide](guides/MODEL_SELECTION_GUIDE.md) - AI model selection
- [Model Selection Diagram](guides/MODEL_SELECTION_DIAGRAM.md) - Model selection flowchart
- [Multi Provider Setup](guides/MULTI_PROVIDER_SETUP.md) - Multiple AI provider setup

## 🗃️ Archived

Legacy documentation (pre-2026) has been moved to [archived/legacy-2026/](archived/legacy-2026/). This includes:
- Historical implementation plans
- Old API integration notes  
- Legacy test reports
- UI mockups and prototypes
- Outdated deployment guides

## 📁 Project Root

Key files in project root:
- [README.md](../README.md) - Main project README
- [CLAUDE.md](../CLAUDE.md) - Claude Code configuration and guidelines

---

**Last Updated:** 2026-02-12  
**Total MCP Tools:** 45 (mcp_backend: 36, mcp_rada: 4, mcp_openreyestr: 5)
