# SecondLayer Documentation

Complete documentation for the SecondLayer legal analysis platform.

## Quick Start

- [START_HERE](guides/START_HERE.md) - Getting started guide
- [QUICK_REFERENCE](guides/QUICK_REFERENCE.md) - Quick reference for common tasks
- [QUICK_START](guides/QUICK_START.md) - Quick start guide

## Client Integration

- **[MCP Client Integration Guide](MCP_CLIENT_INTEGRATION_GUIDE.md) - Complete guide for connecting 10+ LLM clients** ⭐ **NEW**
  - Desktop clients: Claude Desktop, Jan AI, Cherry Studio, Chat-MCP, BoltAI
  - Web clients: LibreChat, AnythingLLM, Open WebUI, Chainlit, ChatGPT Web
  - All transport protocols (stdio, HTTP, SSE, Streamable HTTP)
  - Complete configurations, examples, and troubleshooting

## Backend Services

### MCP Backend (Court Cases & Documents)
- [Backend README](backend/README.md) - Main backend documentation
- [Client Integration](backend/CLIENT_INTEGRATION.md) - How to integrate with the backend
- [SSE Streaming](backend/SSE_STREAMING.md) - Server-Sent Events streaming guide
- [Database Setup](backend/DATABASE_SETUP.md) - PostgreSQL setup and configuration
- [Batch Processing](backend/BATCH_PROCESSING.md) - Batch processing guide
- [Claude Desktop Config](backend/CLAUDE_DESKTOP_CONFIG.md) - Claude Desktop integration
- [JWT Auth Setup](backend/JWT_AUTH_SETUP.md) - JWT authentication configuration
- [Remote MCP Deployment](backend/REMOTE_MCP_DEPLOYMENT.md) - Remote MCP server deployment
- [Config Examples](backend/config-examples/) - Configuration examples

### MCP Rada (Parliament Data)
- [Rada README](rada/README.md) - Parliament data service documentation

### MCP OpenReyestr (Open Registries)
- [OpenReyestr README](openreyestr/README.md) - Open registries service
- [OpenReyestr Data README](openreyestr/OPENREYESTR_README.md) - Data structure and sources
- [Quickstart](openreyestr/QUICKSTART.md) - Quick start guide
- [Database Setup](openreyestr/DATABASE_SETUP.md) - Database configuration
- [Data Sources Schema](openreyestr/DATA_SOURCES_SCHEMA.md) - Data schema documentation
- [Docker Guide](openreyestr/DOCKER_GUIDE.md) - Docker deployment
- [Notaries README](openreyestr/NOTARIES_README.md) - Notaries data documentation
- [Schema Overview](openreyestr/SCHEMA_OVERVIEW.md) - Schema overview

## Deployment

- [DEPLOYMENT](deployment/DEPLOYMENT.md) - Main deployment guide
- [DEPLOYMENT_SUMMARY](deployment/DEPLOYMENT_SUMMARY.md) - Deployment summary
- [DEPLOYMENT_CHECKLIST](deployment/DEPLOYMENT_CHECKLIST.md) - Pre-deployment checklist
- [CONTAINER_ANALYSIS_REPORT](deployment/CONTAINER_ANALYSIS_REPORT.md) - Container analysis
- [DEV_DATABASE_MIGRATION](deployment/DEV_DATABASE_MIGRATION.md) - Database migration guide
- [DEV_SUBDOMAIN_MIGRATION](deployment/DEV_SUBDOMAIN_MIGRATION.md) - Subdomain migration
- [GATE_CONTAINERS_MAP](deployment/GATE_CONTAINERS_MAP.md) - Container mapping
- [WEBSITE_DEPLOYMENT](deployment/WEBSITE_DEPLOYMENT.md) - Website deployment guide

## API Documentation

- **[ALL MCP TOOLS](ALL_MCP_TOOLS.md) - Complete list of all 43 MCP tools (mcp_backend, mcp_rada, mcp_openreyestr)** ⭐
- [MCP Tools List](api/MCP_TOOLS_LIST.md) - List of all MCP tools
- [MCP Tools Schema](api/MCP_TOOLS_SCHEMA.json) - JSON schema for MCP tools
- [MCP Tools Summary](api/MCP_TOOLS_SUMMARY.md) - Tools summary
- [MCP Tools UI](api/MCP_TOOLS_UI.md) - UI integration guide
- [Court Search API Fix](api/COURT_SEARCH_API_FIX.md) - Court search API fixes
- [Court Search Integration](api/COURT_SEARCH_INTEGRATION.md) - Court search integration
- [Integration Summary](api/INTEGRATION_SUMMARY.md) - Integration overview
- [LLM RAG MCP Chat](api/LLM_RAG_MCP_CHAT_IMPLEMENTATION.md) - Chat implementation
- [MCP Client Config](api/MCP_CLIENT_CONFIG.md) - Client configuration

## Testing

- [TESTING](testing/TESTING.md) - Main testing guide
- [QUICKSTART_TESTING](testing/QUICKSTART_TESTING.md) - Quick testing guide
- [DOCUMENT_SERVICE_TESTING](testing/DOCUMENT_SERVICE_TESTING.md) - Document service tests
- [TEST_SUITE_README](testing/TEST_SUITE_README.md) - Test suite documentation
- [TEST_RESULTS_SUMMARY](testing/TEST_RESULTS_SUMMARY.md) - Test results
- [TEST_EXAMPLES](testing/TEST_EXAMPLES.md) - Test examples
- [E2E_TEST_REPORT](testing/E2E_TEST_REPORT.md) - End-to-end test report
- [E2E_QUICK_START](testing/E2E_QUICK_START.md) - E2E quick start

## Security

- [SECURITY](security/SECURITY.md) - Security overview
- [SECURITY_ACTION_PLAN](security/SECURITY_ACTION_PLAN.md) - Security action plan
- [Google OAuth Fix](security/GOOGLE_OAUTH_FIX.md) - OAuth configuration
- [CSP Configuration](security/CSP_CONFIGURATION.md) - Content Security Policy
- [Form Accessibility Fix](security/FORM_ACCESSIBILITY_FIX.md) - Accessibility improvements

## Development

- [REFACTORING](development/REFACTORING.md) - Refactoring guidelines
- [MIGRATION_SUMMARY](development/MIGRATION_SUMMARY.md) - Migration summary
- [IMPLEMENTATION_COMPLETE](development/IMPLEMENTATION_COMPLETE.md) - Implementation status
- [INTEGRATION_COMPLETE](development/INTEGRATION_COMPLETE.md) - Integration status
- [LOGGING_IMPROVEMENTS](development/LOGGING_IMPROVEMENTS.md) - Logging improvements
- [MCP_LOGGING_SETUP_COMPLETE](development/MCP_LOGGING_SETUP_COMPLETE.md) - Logging setup
- [Stage 4: Vault Implementation](development/STAGE4_VAULT_IMPLEMENTATION.md) - Vault implementation
- [Stage 5: Implementation](development/STAGE5_IMPLEMENTATION.md) - Stage 5 details
- [Cost Tracking Analysis](development/COST_TRACKING_ANALYSIS.md) - Cost tracking
- [Cost Transparency](development/COST_TRANSPARENCY.md) - Cost transparency guide
- [Legislation Storage](development/LEGISLATION_STORAGE_SOLUTION.md) - Legislation storage
- [LexWebApp Backend Requirements](development/LEXWEBAPP_BACKEND_REQUIREMENTS.md) - Requirements
- [UI Fixes Menu](development/UI_FIXES_MENU.md) - UI improvements

## Guides

- [Quick Start Guide](guides/QUICK_START_GUIDE.md) - Detailed quick start
- [Model Selection Guide](guides/MODEL_SELECTION_GUIDE.md) - AI model selection
- [Model Selection Diagram](guides/MODEL_SELECTION_DIAGRAM.md) - Model selection flowchart
- [Multi Provider Setup](guides/MULTI_PROVIDER_SETUP.md) - Multiple AI provider setup

## Archived

Historical documentation and outdated materials:
- [Integration Guide Web](archived/INTEGRATION_GUIDE_WEB.html)
- [ZakonOnline Support Request](archived/zakononline_support_request.md)
- [ZakonOnline Support Request (EN)](archived/zakononline_support_request_EN.md)
- Ukrainian legacy docs

## Project Root

Key files in the project root:
- [README.md](../README.md) - Main project README
- [CLAUDE.md](../CLAUDE.md) - Claude Code configuration and guidelines
