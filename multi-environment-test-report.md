# 🧪 Multi-Environment OAuth Test Report

**Date:** 2026-02-02
**Test Framework:** Playwright
**Environments Tested:** Development, Staging, Production

---

## 📊 Overall Results

| Environment | Status | Login Page | OAuth Config | Backend Health | Frontend |
|-------------|--------|------------|--------------|----------------|----------|
| **Development** | ✅ **PASS** | ✅ | ✅ | ✅ | ✅ |
| **Staging** | ⚠️ **PARTIAL** | ℹ️ | ❌ | ✅ | ✅ |
| **Production** | ❌ **FAIL** | ℹ️ | ❌ | ❌ | ✅ |

---

## 🎯 Development Environment (dev.legal.org.ua)

### ✅ Status: FULLY WORKING

#### Test Results:
- ✅ **Login Page**: Displayed correctly
- ✅ **OAuth Configuration**: Correct
  - Callback URL: `https://dev.legal.org.ua/auth/callback`
  - Client ID: `323273425312-4chgdc3...`
  - Redirect: 302 → Google OAuth
- ✅ **Backend Health**: Healthy
  - Service: `secondlayer-mcp-http`
- ✅ **Frontend**: Loaded successfully

### 🎉 Verdict: Ready for use!

---

## ⚠️ Staging Environment (stage.legal.org.ua)

### Status: PARTIAL - Needs Configuration Fix

#### Test Results:
- ℹ️ **Login Page**: Not shown (possible auth state)
- ❌ **OAuth Configuration**: **INCORRECT CALLBACK URL**
  - Expected: `https://stage.legal.org.ua/auth/callback`
  - Actual: `https://stage.legal.org.ua/auth/google/callback` ❌
  - **Problem**: Extra `/google/` in path
- ✅ **Backend Health**: Healthy
  - Service: `secondlayer-mcp-http`
- ✅ **Frontend**: Loaded successfully

### 🔧 Required Fix:

Update `.env.stage` file:
```bash
# Change from:
GOOGLE_CALLBACK_URL=https://stage.legal.org.ua/auth/google/callback

# To:
GOOGLE_CALLBACK_URL=https://stage.legal.org.ua/auth/callback
```

---

## ❌ Production Environment (legal.org.ua)

### Status: MULTIPLE ISSUES

#### Test Results:
- ℹ️ **Login Page**: Not shown
- ❌ **OAuth Configuration**: **NOT WORKING**
  - Expected: 302 redirect
  - Actual: 200 response (no redirect)
  - **Problem**: OAuth endpoint returns page instead of redirecting
- ❌ **Backend Health**: **WRONG FORMAT**
  - Expected: JSON `{"status":"ok",...}`
  - Actual: Plain text `"healthy"`
  - **Problem**: Different health check format or wrong endpoint
- ✅ **Frontend**: Loaded successfully

### 🔧 Required Fixes:

1. **Check if backend is running correctly:**
   ```bash
   ssh vovkes@gate.lexapp.co.ua "docker ps | grep prod"
   ```

2. **Verify OAuth routes are registered:**
   - Check if `/auth/google` endpoint exists
   - Verify Passport Google strategy is configured

3. **Fix health endpoint:**
   - Should return JSON: `{"status":"ok","service":"..."}`
   - Currently returns plain text

---

## 📋 Comparison Table

### OAuth Callback URLs:

| Environment | Callback URL | Status |
|-------------|--------------|--------|
| Development | `https://dev.legal.org.ua/auth/callback` | ✅ Correct |
| Staging | `https://stage.legal.org.ua/auth/google/callback` | ❌ Wrong (extra `/google/`) |
| Production | N/A (not redirecting) | ❌ Not working |

### Client ID:
All environments use the same Client ID: `323273425312-4chgdc3...` ✅

---

## 🚨 Critical Issues

### 1. Staging: Wrong Callback URL
**Impact:** OAuth will fail - Google will redirect to wrong URL
**Priority:** HIGH
**Fix:** Update `GOOGLE_CALLBACK_URL` in `.env.stage`

### 2. Production: OAuth Not Working
**Impact:** Users cannot login
**Priority:** CRITICAL
**Fix:**
- Check backend configuration
- Verify auth routes are loaded
- Check if Google OAuth is enabled in production

### 3. Production: Health Check Format
**Impact:** Monitoring may fail
**Priority:** MEDIUM
**Fix:** Update health endpoint to return JSON

---

## ✅ Recommendations

### Immediate Actions:

1. **Fix Staging Callback URL** (5 minutes)
   ```bash
   # Edit .env.stage
   GOOGLE_CALLBACK_URL=https://stage.legal.org.ua/auth/callback

   # Restart backend
   docker compose -f docker-compose.stage.yml restart app-stage
   ```

2. **Debug Production Backend** (15-30 minutes)
   - Check logs: `docker logs secondlayer-app-prod`
   - Verify environment variables
   - Check if auth module is loaded

3. **Update Google OAuth Console** (if needed)
   - Add all callback URLs to authorized redirects:
     - `https://dev.legal.org.ua/auth/callback` ✅
     - `https://stage.legal.org.ua/auth/callback` (after fix)
     - `https://legal.org.ua/auth/callback`

### Testing After Fixes:

```bash
# Rerun tests
npx playwright test test-all-environments.spec.ts
```

---

## 📝 Test Details

**Total Tests:** 13
**Passed:** 10
**Failed:** 3
**Duration:** 10.5s

**Test Coverage:**
- Login page display
- OAuth configuration & redirects
- Backend health checks
- Frontend asset loading
- Cross-environment comparison

---

## 🎯 Summary

✅ **Development**: Fully working, ready for testing
⚠️ **Staging**: Needs callback URL fix (simple config change)
❌ **Production**: Critical issues - OAuth not working at all

**Next Steps:**
1. Fix staging callback URL
2. Investigate production backend issues
3. Retest all environments
4. Update Google OAuth Console with correct URLs
