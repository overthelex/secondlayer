# Security Vulnerabilities Action Plan

**Generated**: 2026-01-26
**Status**: 17 open vulnerabilities (8 HIGH, 6 MEDIUM, 3 LOW)
**Dashboard**: https://github.com/overthelex/secondlayer/security/dependabot

## ✅ Completed Steps

- [x] Created SECURITY.md policy
- [x] Enabled vulnerability alerts
- [x] Created Dependabot configuration (.github/dependabot.yml)
- [x] Pushed configuration to GitHub

## 🚨 Critical Priority (HIGH Severity - 8 alerts)

### 1. @modelcontextprotocol/sdk - **URGENT**
**Affected**: mcp_backend, mcp_rada, root package-lock.json
**Current Version**: 0.5.0
**Fix Version**: ≥1.25.2
**Issues**:
- ReDoS (Regular Expression Denial of Service)
- DNS rebinding protection not enabled by default

**Action Required**:
```bash
# Update mcp_backend
cd mcp_backend
npm install @modelcontextprotocol/sdk@latest
npm audit fix

# Update mcp_rada
cd ../mcp_rada
npm install @modelcontextprotocol/sdk@latest
npm audit fix

# Update root
cd ..
npm install @modelcontextprotocol/sdk@latest
npm audit fix
```

**Risk**: High - Could allow attackers to cause service disruption or bypass security controls

### 2. tar (buytoken/server) - **CRITICAL**
**Affected**: buytoken/server
**Current Version**: < 7.5.4
**Fix Version**: ≥7.5.4
**CVSS Score**: 8.8
**Issues**:
- Arbitrary file overwrite
- Symlink poisoning
- Race condition in path reservations

**Action Required**:
```bash
cd buytoken/server
npm update tar
npm audit fix --force
```

**Risk**: Critical - Could allow arbitrary file system access and code execution

## ⚠️ High Priority (MEDIUM Severity - 6 alerts)

### 3. nodemailer (buytoken/server)
**Affected**: buytoken/server
**Current Version**: < 7.0.11
**Fix Version**: ≥7.0.11
**Issues**:
- DoS through uncontrolled recursion
- Email to unintended domain

**Action Required**:
```bash
cd buytoken/server
npm update nodemailer
npm audit fix
```

### 4. lodash / lodash-es
**Affected**: buytoken/server, mcpadmin_ui
**Current Version**: < 4.17.23
**Fix Version**: ≥4.17.23
**Issues**: Prototype pollution in `_.unset` and `_.omit`

**Action Required**:
```bash
# Update buytoken/server
cd buytoken/server
npm update lodash
npm audit fix

# Update mcpadmin_ui
cd ../mcpadmin_ui
npm update lodash-es
npm audit fix
```

### 5. esbuild (lexwebapp)
**Affected**: lexwebapp
**Current Version**: < 0.25.0
**Fix Version**: ≥0.25.0
**Issues**: Development server allows unauthorized requests

**Action Required**:
```bash
cd lexwebapp
npm update esbuild
npm audit fix
```

## ℹ️ Low Priority (LOW Severity - 3 alerts)

### 6. diff
**Affected**: buytoken/server, root package-lock.json
**Current Version**: < 4.0.4
**Fix Version**: ≥4.0.4
**Issues**: DoS in parsePatch and applyPatch

**Action Required**:
```bash
# Update mcp_backend (uses diff ^4.0.2)
cd mcp_backend
npm update diff
npm audit fix

# Update buytoken/server
cd ../buytoken/server
npm update diff
npm audit fix
```

## 📋 Execution Plan

### Phase 1: Critical Fixes (Do Immediately)
1. **Fix tar in buytoken/server** (CVSS 8.8)
2. **Update @modelcontextprotocol/sdk** in all packages (6 alerts)

### Phase 2: Medium Priority (This Week)
3. Update nodemailer in buytoken/server
4. Update lodash/lodash-es in buytoken/server and mcpadmin_ui
5. Update esbuild in lexwebapp

### Phase 3: Low Priority (Next Sprint)
6. Update diff in mcp_backend and buytoken/server

### Phase 4: Testing & Verification
7. Run full test suite: `npm test` in each package
8. Test MCP servers: `npm run dev:http` in mcp_backend and mcp_rada
9. Test web apps: lexwebapp and mcpadmin_ui
10. Verify all Dependabot alerts are resolved

## 🤖 Automated Updates

Dependabot is now configured to:
- Check for security updates weekly (Mondays)
- Create PRs for vulnerable dependencies
- Group related updates together
- Label PRs by component (backend, rada, frontend, etc.)

**Monitor**: https://github.com/overthelex/secondlayer/security/dependabot

## 📊 Progress Tracking

| Package | Severity | Status | Assignee | Due Date |
|---------|----------|--------|----------|----------|
| @modelcontextprotocol/sdk | HIGH | ⏳ Pending | - | ASAP |
| tar | HIGH | ⏳ Pending | - | ASAP |
| nodemailer | MEDIUM | ⏳ Pending | - | This week |
| lodash/lodash-es | MEDIUM | ⏳ Pending | - | This week |
| esbuild | MEDIUM | ⏳ Pending | - | This week |
| diff | LOW | ⏳ Pending | - | Next sprint |

## 🔍 Post-Update Verification Commands

After applying updates, run:

```bash
# Check for remaining vulnerabilities
npm audit

# Run full audit across monorepo
npm run install:all
cd mcp_backend && npm audit
cd ../mcp_rada && npm audit
cd ../lexwebapp && npm audit
cd ../mcpadmin_ui && npm audit
cd ../buytoken/server && npm audit

# Run tests
cd mcp_backend && npm test
cd ../mcp_rada && npm test

# Check Dependabot status
gh api repos/overthelex/secondlayer/dependabot/alerts --jq 'length'
```

## 📝 Breaking Changes

### @modelcontextprotocol/sdk (0.5.0 → 1.25.2)

**MAJOR VERSION UPGRADE** - Expect breaking changes!

1. Review migration guide: https://github.com/modelcontextprotocol/typescript-sdk/releases
2. Check API changes in:
   - `mcp_backend/src/index.ts`
   - `mcp_backend/src/http-server.ts`
   - `mcp_rada/src/index.ts`
3. Update server initialization code
4. Test all MCP tools thoroughly

**Likely Changes**:
- Constructor parameters
- Server lifecycle methods
- Tool registration API
- Transport configuration

## 🛡️ Prevention

Going forward:
1. ✅ Dependabot will auto-create PRs for security updates
2. ✅ Review and merge Dependabot PRs promptly
3. ✅ Run `npm audit` before each deployment
4. ✅ Monitor security dashboard weekly
5. ✅ Keep dependencies up to date (weekly checks)

## 📞 Support

- Security issues: security@legal.org.ua
- Dependabot alerts: https://github.com/overthelex/secondlayer/security/dependabot
- General questions: [Create an issue](https://github.com/overthelex/secondlayer/issues)

---

**Next Review**: After Phase 1 completion
**Last Updated**: 2026-01-26
