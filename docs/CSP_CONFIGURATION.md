# Content Security Policy (CSP) Configuration

**Issue:** "Content Security Policy blocks the use of 'eval' in JavaScript"
**Status:** ✅ Fixed
**Date:** 2026-01-21

---

## Problem

React/Vite applications sometimes require `eval()` and inline scripts for proper operation. Without a proper Content Security Policy header, browsers may either:
1. Apply overly strict default CSP
2. Block JavaScript execution from browser extensions
3. Show CSP violation warnings

**Error Message:**
```
Content Security Policy of your site blocks the use of 'eval' in JavaScript
```

---

## Solution

Added a development-appropriate CSP header to the nginx configuration that allows React/Vite to function while maintaining reasonable security.

### CSP Header Added

**File:** `Lexwebapp/nginx.conf`

```nginx
# Content Security Policy for React/Vite application
add_header Content-Security-Policy "default-src 'self'; script-src 'self' 'unsafe-inline' 'unsafe-eval'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com data:; img-src 'self' data: https:; connect-src 'self' https://dev.legal.org.ua wss://dev.legal.org.ua" always;
```

### CSP Directives Explained

| Directive | Value | Purpose |
|-----------|-------|---------|
| **default-src** | `'self'` | Default policy: only load resources from same origin |
| **script-src** | `'self' 'unsafe-inline' 'unsafe-eval'` | Allow scripts from same origin, inline scripts, and eval() |
| **style-src** | `'self' 'unsafe-inline' https://fonts.googleapis.com` | Allow styles from same origin, inline styles, and Google Fonts |
| **font-src** | `'self' https://fonts.gstatic.com data:` | Allow fonts from same origin, Google Fonts CDN, and data URIs |
| **img-src** | `'self' data: https:` | Allow images from same origin, data URIs, and HTTPS sources |
| **connect-src** | `'self' https://dev.legal.org.ua wss://dev.legal.org.ua` | Allow API calls to dev subdomain (HTTP and WebSocket) |

---

## Why `unsafe-eval` is Needed

React and Vite applications may use `eval()` for:
- **Hot Module Replacement (HMR)** in development
- **Dynamic imports** and code splitting
- **Source map processing** for debugging
- **Runtime JSX compilation** in some configurations

For **development environments**, allowing `unsafe-eval` is acceptable and common practice.

---

## Security Considerations

### Development vs Production

**Development (Current):**
- ✅ `unsafe-inline` and `unsafe-eval` enabled
- ✅ Allows debugging and source maps
- ✅ Faster development workflow

**Production (Recommended):**
For production, consider a stricter CSP:
```nginx
Content-Security-Policy: "default-src 'self'; script-src 'self'; style-src 'self' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data: https:; connect-src 'self' https://legal.org.ua"
```

Vite production builds typically don't require `unsafe-eval`.

---

## Verification

### Check CSP Header is Present

```bash
curl -I https://dev.legal.org.ua/ | grep -i content-security-policy
```

**Expected Output:**
```
content-security-policy: default-src 'self'; script-src 'self' 'unsafe-inline' 'unsafe-eval'; ...
```

### Test in Browser

1. Open https://dev.legal.org.ua/
2. Open Browser DevTools (F12)
3. Go to **Console** tab
4. Should see no CSP errors
5. Application should load and run normally

### Check CSP Violations (if any)

In DevTools Console, filter for "CSP" to see any violations:
```
Content Security Policy: <violation details>
```

---

## Troubleshooting

### Still Seeing CSP Errors

**1. Browser Extension Conflict**

Some browser extensions inject their own CSP. Try:
- Open in **Incognito/Private mode** (disables most extensions)
- Disable ad blockers or security extensions temporarily
- Check if error persists

**2. Cache Issues**

Clear browser cache:
```bash
# Chrome/Edge
Ctrl+Shift+Delete → Clear browsing data → Cached images and files

# Firefox
Ctrl+Shift+Delete → Cache
```

Or force reload: `Ctrl+Shift+R` (Windows/Linux) or `Cmd+Shift+R` (Mac)

**3. Verify Nginx Configuration**

Check the CSP header is actually being sent:
```bash
ssh gate "docker exec lexwebapp-dev cat /etc/nginx/conf.d/default.conf | grep -A 1 Content-Security-Policy"
```

**4. Check for Multiple CSP Headers**

Multiple CSP headers can conflict. Verify only one CSP header exists:
```bash
curl -I https://dev.legal.org.ua/ 2>&1 | grep -i content-security-policy
```

Should see exactly **one** CSP header.

---

## Future Improvements

### 1. Use Nonce-based CSP (More Secure)

Instead of `unsafe-inline`, use nonces:

```nginx
# Generate random nonce per request
set $csp_nonce $request_id;
add_header Content-Security-Policy "script-src 'nonce-$csp_nonce' 'self'";
```

Then inject nonce into HTML:
```html
<script nonce="<%= nonce %>">...</script>
```

### 2. CSP Reporting

Monitor CSP violations:
```nginx
add_header Content-Security-Policy "...; report-uri /csp-report";
```

Backend endpoint to log violations:
```typescript
app.post('/csp-report', (req, res) => {
  logger.warn('CSP Violation:', req.body);
  res.status(204).end();
});
```

### 3. Environment-Specific CSP

Different CSP for dev vs prod:

**Development:** Permissive (current configuration)
**Production:** Strict (remove `unsafe-eval`)

---

## Related Documentation

- [MDN: Content Security Policy](https://developer.mozilla.org/en-US/docs/Web/HTTP/CSP)
- [CSP Evaluator](https://csp-evaluator.withgoogle.com/) - Test your CSP
- [Vite Security Best Practices](https://vitejs.dev/guide/build.html#production)

---

## Changes Made

### 1. Updated Nginx Configuration
**File:** `Lexwebapp/nginx.conf`

Added CSP header with appropriate directives for React/Vite development.

### 2. Rebuilt Docker Image
```bash
docker build --platform linux/amd64 --no-cache -f Dockerfile.dev -t lexwebapp-lexwebapp:dev .
```

### 3. Deployed to Gate Server
```bash
docker save lexwebapp-lexwebapp:dev | gzip > /tmp/lexwebapp-dev-csp.tar.gz
scp /tmp/lexwebapp-dev-csp.tar.gz gate:/tmp/
ssh gate "gunzip -c /tmp/lexwebapp-dev-csp.tar.gz | docker load"
ssh gate "cd /home/vovkes/secondlayer-deployment && docker compose -f docker-compose.dev.yml up -d lexwebapp-dev"
```

### 4. Verified CSP Header
```bash
curl -I https://dev.legal.org.ua/ | grep -i content-security-policy
# ✅ CSP header present and correct
```

---

**Status:** ✅ CSP Configured and Deployed
**Environment:** Development (dev.legal.org.ua)
**Impact:** Allows React/Vite JavaScript execution including eval()
