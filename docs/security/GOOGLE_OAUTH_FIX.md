# Google OAuth Configuration Fix

**Issue:** Error 400: redirect_uri_mismatch
**Status:** ✅ Backend configured correctly
**Action Required:** Update Google Cloud Console

---

## Problem

The OAuth callback URL was incorrectly configured as:
- ❌ Old: `https://dev.legal.org.ua/auth/callback`
- ✅ Correct: `https://dev.legal.org.ua/auth/google/callback`

The backend route is `/auth/google/callback` (not just `/auth/callback`), so the full URL must include `/google`.

---

## Backend Configuration ✅

**File:** `/home/vovkes/secondlayer-deployment/docker-compose.dev.yml`

**Current Settings (Verified Working):**
```yaml
GOOGLE_CALLBACK_URL: https://dev.legal.org.ua/auth/google/callback
FRONTEND_URL: https://dev.legal.org.ua
ALLOWED_ORIGINS: https://dev.legal.org.ua
```

**Backend Logs Confirm:**
```
callbackURL: "https://dev.legal.org.ua/auth/google/callback"
clientId: "323273425312-4chgdc3..."
```

---

## Google Cloud Console Configuration Required ⚠️

### Step 1: Open Google Cloud Console

Go to: https://console.cloud.google.com/apis/credentials

### Step 2: Find Your OAuth Client

Look for:
- **Client ID:** `323273425312-4chgdc38o82r611f9r1403sfcrvcs5jp.apps.googleusercontent.com`
- **Name:** (Your OAuth 2.0 client name)

### Step 3: Edit Authorized Redirect URIs

Click on the OAuth client to edit, then in the "Authorized redirect URIs" section:

#### Add the Following URLs:

```
https://dev.legal.org.ua/auth/google/callback
https://legal.org.ua/auth/google/callback
```

**Explanation:**
- First URL is for **development** environment
- Second URL is for **production** environment (add it proactively)

#### Optional: Remove Old URLs

If present, you can remove these old path-based URLs:
```
https://legal.org.ua/development/auth/callback
https://legal.org.ua/development/auth/google/callback
```

### Step 4: Save Changes

Click "SAVE" at the bottom of the form.

⚠️ **Important:** Changes take effect immediately, but Google sometimes caches OAuth settings for a few minutes.

---

## Testing After Configuration

### 1. Test OAuth Flow

Visit: https://dev.legal.org.ua/

Click "Login with Google" or navigate to:
```
https://dev.legal.org.ua/auth/google
```

### 2. Expected Behavior

1. **Redirect to Google:** You'll be redirected to Google's login page
2. **Select Account:** Choose your Google account
3. **Grant Permission:** If first time, approve the application
4. **Redirect Back:** You'll be redirected to:
   ```
   https://dev.legal.org.ua/auth/google/callback?code=...
   ```
5. **Final Redirect:** Backend will redirect you to:
   ```
   https://dev.legal.org.ua/login?token=<JWT_TOKEN>
   ```

### 3. Troubleshooting

**If you still see "redirect_uri_mismatch":**

1. Wait 2-3 minutes for Google's cache to clear
2. Try in an incognito/private browser window
3. Verify the exact URL in the error message matches what you added
4. Check for typos in the Google Console configuration

**If OAuth succeeds but redirect fails:**

Check backend logs:
```bash
ssh gate "docker logs secondlayer-app-dev --tail 50 | grep -i oauth"
```

---

## Production Environment (Future)

When you're ready to enable OAuth for production, add:

```
https://legal.org.ua/auth/google/callback
```

Then update production docker-compose:
```yaml
# In docker-compose.prod.yml
GOOGLE_CALLBACK_URL: https://legal.org.ua/auth/google/callback
FRONTEND_URL: https://legal.org.ua
ALLOWED_ORIGINS: https://legal.org.ua
```

---

## Current OAuth Configuration Summary

| Environment | OAuth Init URL | Callback URL |
|-------------|---------------|--------------|
| **Development** | `https://dev.legal.org.ua/auth/google` | `https://dev.legal.org.ua/auth/google/callback` |
| **Production** | `https://legal.org.ua/auth/google` | `https://legal.org.ua/auth/google/callback` |

---

## Alternative: Bearer Token Authentication

If you don't want to wait for OAuth configuration, you can use API key authentication:

```bash
# Get API key from backend
ssh gate "docker exec secondlayer-app-dev env | grep SECONDARY_LAYER_KEYS"
# Output: c3462787ee0a9b45a1102cc195a65f8ce82c7609242aab5628d4a111c52727b4

# Use in API requests
curl -H "Authorization: Bearer c3462787ee0a9b45a1102cc195a65f8ce82c7609242aab5628d4a111c52727b4" \
  https://dev.legal.org.ua/api/tools
```

---

## Quick Reference

**Correct Callback URL:** `https://dev.legal.org.ua/auth/google/callback`
**Google Console:** https://console.cloud.google.com/apis/credentials
**Client ID:** `323273425312-4chgdc38o82r611f9r1403sfcrvcs5jp.apps.googleusercontent.com`

---

**Status:** ✅ Backend Ready | ⚠️ Google Console Update Required
