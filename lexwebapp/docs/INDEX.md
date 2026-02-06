# Lexwebapp Documentation Index

Complete documentation for the MCP Streaming Integration.

---

## 🚀 Quick Start

**New to the project?** Start here:

1. **[QUICK_START.md](QUICK_START.md)** - Get running in 5 minutes
2. **[BUILD_SUMMARY.md](../BUILD_SUMMARY.md)** - What was built and how to deploy
3. **[MCP_STREAMING_INTEGRATION.md](MCP_STREAMING_INTEGRATION.md)** - Complete integration guide

---

## 📚 Documentation by Category

### Getting Started

| Document | Description | Audience |
|----------|-------------|----------|
| [QUICK_START.md](QUICK_START.md) | 5-minute quick start guide | Developers |
| [BUILD_SUMMARY.md](../BUILD_SUMMARY.md) | Build and deployment summary | DevOps, PM |

### Developer Guides

| Document | Description | Lines |
|----------|-------------|-------|
| [MCP_STREAMING_INTEGRATION.md](MCP_STREAMING_INTEGRATION.md) | Complete integration guide | 1400+ |
| [../src/__tests__/README.md](../src/__tests__/README.md) | Testing guide | 300+ |

### API Reference

| Document | Description | Tools |
|----------|-------------|-------|
| [../../docs/ALL_MCP_TOOLS.md](../../docs/ALL_MCP_TOOLS.md) | All 43 MCP tools reference | 43 tools |
| [../../mcp_backend/docs/api-explorer.html](../../mcp_backend/docs/api-explorer.html) | Interactive API explorer | Visual UI |

### Architecture & Design

| Document | Description | Scope |
|----------|-------------|-------|
| [MCP_STREAMING_INTEGRATION.md#architecture](MCP_STREAMING_INTEGRATION.md#architecture) | System architecture | Frontend |
| [../../docs/MCP_CLIENT_INTEGRATION_GUIDE.md](../../docs/MCP_CLIENT_INTEGRATION_GUIDE.md) | Client integration patterns | All clients |

### Deployment

| Document | Description | Environment |
|----------|-------------|-------------|
| [BUILD_SUMMARY.md](../BUILD_SUMMARY.md) | Build instructions | Staging |
| [../../deployment/GATEWAY_SETUP.md](../../deployment/GATEWAY_SETUP.md) | Multi-environment setup | All envs |
| [../../deployment/LOCAL_DEVELOPMENT.md](../../deployment/LOCAL_DEVELOPMENT.md) | Local dev setup | Development |

### Backend Docs

| Document | Description | Backend |
|----------|-------------|---------|
| [../../mcp_backend/docs/SSE_STREAMING.md](../../mcp_backend/docs/SSE_STREAMING.md) | SSE protocol docs | mcp_backend |
| [../../mcp_backend/docs/CLIENT_INTEGRATION.md](../../mcp_backend/docs/CLIENT_INTEGRATION.md) | Backend integration | mcp_backend |

---

## 📖 Reading Paths

### Path 1: Developer Onboarding

For new developers joining the project:

1. Read: [QUICK_START.md](QUICK_START.md)
2. Skim: [MCP_STREAMING_INTEGRATION.md](MCP_STREAMING_INTEGRATION.md)
3. Code: Follow usage examples
4. Test: Run `npm test`
5. Reference: [API Explorer](../../mcp_backend/docs/api-explorer.html)

**Time:** ~2 hours

### Path 2: Integration Implementation

For implementing MCP tools in a new component:

1. Read: [MCP_STREAMING_INTEGRATION.md#usage-examples](MCP_STREAMING_INTEGRATION.md#usage-examples)
2. Reference: [API Reference](MCP_STREAMING_INTEGRATION.md#api-reference)
3. Code: Use `useMCPTool` hook
4. Test: Write unit tests
5. Deploy: Follow [BUILD_SUMMARY.md](../BUILD_SUMMARY.md)

**Time:** ~4 hours

### Path 3: Deployment

For deploying to staging/production:

1. Read: [BUILD_SUMMARY.md](../BUILD_SUMMARY.md)
2. Configure: Environment variables
3. Build: `npm run build:staging`
4. Test: Run test suite
5. Deploy: Docker commands
6. Verify: Testing checklist

**Time:** ~1 hour

### Path 4: Troubleshooting

For fixing issues:

1. Check: [MCP_STREAMING_INTEGRATION.md#troubleshooting](MCP_STREAMING_INTEGRATION.md#troubleshooting)
2. Debug: Browser console + network tab
3. Test: Backend with curl
4. Verify: Environment variables
5. Rollback: If needed

**Time:** ~30 minutes

---

## 🔍 Finding Information

### By Topic

| Topic | Document | Section |
|-------|----------|---------|
| **SSE Streaming** | MCP_STREAMING_INTEGRATION.md | Architecture |
| **All Tools** | ../../docs/ALL_MCP_TOOLS.md | Full list |
| **Hook Usage** | MCP_STREAMING_INTEGRATION.md | Usage Examples |
| **Testing** | src/__tests__/README.md | All sections |
| **Deployment** | BUILD_SUMMARY.md | Build & Deploy |
| **Troubleshooting** | MCP_STREAMING_INTEGRATION.md | Troubleshooting |
| **API Reference** | MCP_STREAMING_INTEGRATION.md | API Reference |
| **Environment** | BUILD_SUMMARY.md | Environment Variables |

### By File

| File/Component | Document | Section |
|----------------|----------|---------|
| SSEClient.ts | MCP_STREAMING_INTEGRATION.md | Core Components |
| MCPService.ts | MCP_STREAMING_INTEGRATION.md | Core Components |
| useMCPTool.ts | MCP_STREAMING_INTEGRATION.md | Core Components |
| chatStore.ts | MCP_STREAMING_INTEGRATION.md | Core Components |
| ChatPage | MCP_STREAMING_INTEGRATION.md | Usage Examples |
| ChatLayout | MCP_STREAMING_INTEGRATION.md | Usage Examples |

### By Error

| Error | Document | Section |
|-------|----------|---------|
| CORS | MCP_STREAMING_INTEGRATION.md | Troubleshooting |
| Stream hangs | MCP_STREAMING_INTEGRATION.md | Troubleshooting |
| TypeScript | MCP_STREAMING_INTEGRATION.md | Troubleshooting |
| Tests fail | src/__tests__/README.md | Troubleshooting |
| Build fails | BUILD_SUMMARY.md | Build Commands |

---

## 📦 Document Formats

| Format | Files | Usage |
|--------|-------|-------|
| Markdown | All .md files | Reading, GitHub |
| HTML | api-explorer.html | Interactive browsing |
| TypeScript | *.ts, *.tsx | Code reference |
| JSON | package.json | Dependencies |
| YAML | docker-compose.yml | Deployment |

---

## 🔄 Document Updates

### Version History

| Date | Version | Changes |
|------|---------|---------|
| 2026-02-06 | 1.0.0 | Initial release |

### Contributing

To update documentation:

1. Edit the relevant .md file
2. Update version history
3. Rebuild if needed
4. Commit with clear message

---

## 📊 Documentation Stats

| Metric | Count |
|--------|-------|
| Total Documents | 15+ |
| Total Lines | 5000+ |
| Code Examples | 50+ |
| API Tools Documented | 43 |
| Test Files | 4 |

---

## 🔗 External Resources

### Official Docs
- [Vite Documentation](https://vitejs.dev/)
- [React Documentation](https://react.dev/)
- [Vitest Documentation](https://vitest.dev/)
- [Zustand Documentation](https://docs.pmnd.rs/zustand/)

### Related Projects
- [MCP Backend](../../mcp_backend/README.md)
- [RADA Server](../../mcp_rada/README.md)
- [OpenReyestr](../../mcp_openreyestr/README.md)

### Community
- [GitHub Issues](https://github.com/anthropics/claude-code/issues)
- [Stack Overflow](https://stackoverflow.com/questions/tagged/mcp)

---

## 📧 Contact

For questions or support:

- **Email:** support@legal.org.ua
- **GitHub:** https://github.com/anthropics/claude-code
- **Issues:** https://github.com/anthropics/claude-code/issues

---

**Last Updated:** 2026-02-06
**Maintained by:** SecondLayer Team
