# Google OAuth2 Setup Guide

## ✅ Implementation Complete!

Your SecondLayer payment system now supports **Google OAuth2 authentication** with automatic unique UID assignment for billing!

### What's Been Implemented

1. ✅ **Passport Google OAuth2 Strategy** (`src/config/passport.ts`)
   - Handles Google authentication flow
   - Auto-creates users with UUID (gen_random_uuid())
   - Links Google accounts to existing email users
   - Sets email_verified=TRUE automatically

2. ✅ **OAuth2 Controllers** (`src/controllers/auth.ts`)
   - `googleOAuthInit` - Redirects to Google login
   - `googleOAuthCallback` - Processes OAuth response, creates/links user, returns JWT

3. ✅ **User Linking Logic**
   - **New Google User**: Creates new user with UUID
   - **Existing Email**: Links Google account to existing user
   - **Returning User**: Logs in existing Google user

4. ✅ **Unique UID for Billing**
   - Every user gets UUID automatically (database default: gen_random_uuid())
   - UUID visible in user object: `user.id`
   - Used for all billing operations

---

## 🔐 Setup Google OAuth2 Credentials

### Step 1: Configure OAuth Consent Screen

1. Open Google Cloud Console:
```bash
open "https://console.cloud.google.com/apis/credentials/consent?project=gen-lang-client-0208700641"
```

2. **Configure Consent Screen**:
   - **User Type**: External (for public users)
   - **App name**: SecondLayer Payment System
   - **User support email**: shepherdvovkes@gmail.com
   - **App logo**: (optional)
   - **Authorized domains**: (leave empty for localhost testing)
   - **Developer contact**: shepherdvovkes@gmail.com

3. **Add Scopes**:
   - Click "ADD OR REMOVE SCOPES"
   - Select:
     - `../auth/userinfo.email`
     - `../auth/userinfo.profile`
     - `openid`
   - Save

4. **Test Users** (for testing mode):
   - Add email: shepherdvovkes@gmail.com
   - Add any other test emails you need

5. Click **SAVE AND CONTINUE** through all steps

---

### Step 2: Create OAuth2 Client ID

1. Open Credentials Page:
```bash
open "https://console.cloud.google.com/apis/credentials?project=gen-lang-client-0208700641"
```

2. Click **"+ CREATE CREDENTIALS"** → **"OAuth client ID"**

3. **Configure Client**:
   - **Application type**: Web application
   - **Name**: SecondLayer Web Client

4. **Authorized JavaScript origins**:
   ```
   http://localhost:3001
   ```

5. **Authorized redirect URIs**:
   ```
   http://localhost:3001/api/auth/google/callback
   ```

6. Click **CREATE**

7. **Copy Credentials**:
   - You'll see a dialog with:
     - **Client ID**: `xxxxx.apps.googleusercontent.com`
     - **Client Secret**: `GOCSPX-xxxxx`
   - **Download JSON** (optional backup)

---

### Step 3: Update .env File

Edit `/Users/vovkes/ZOMCP/SecondLayer/buytoken/server/.env`:

```bash
# Replace these lines:
GOOGLE_CLIENT_ID=your-actual-client-id.apps.googleusercontent.com
GOOGLE_CLIENT_SECRET=GOCSPX-your-actual-secret
GOOGLE_CALLBACK_URL=http://localhost:3001/api/auth/google/callback
```

**Quick update command** (replace with your actual values):
```bash
cd /Users/vovkes/ZOMCP/SecondLayer/buytoken/server

# Update .env (use your actual credentials!)
sed -i '' 's/GOOGLE_CLIENT_ID=placeholder/GOOGLE_CLIENT_ID=YOUR_CLIENT_ID/' .env
sed -i '' 's/GOOGLE_CLIENT_SECRET=placeholder/GOOGLE_CLIENT_SECRET=YOUR_SECRET/' .env
```

---

### Step 4: Restart Server

```bash
# Kill existing server
lsof -ti :3001 | xargs kill -9 2>/dev/null

# Start server with new OAuth2 config
npm run start &

# Or rebuild and start
npm run build && npm run start
```

---

## 🧪 Testing OAuth2 Flow

### Test 1: Google OAuth Redirect

```bash
# Open browser to initiate OAuth flow
open "http://localhost:3001/api/auth/google"
```

**Expected Flow:**
1. Redirects to Google login page
2. Shows consent screen (approve scopes)
3. Redirects back to callback URL
4. Creates user with UUID
5. Redirects to profile page with token

**Check Logs:**
```bash
# You should see in server logs:
✓ New Google user registered: user@gmail.com (UID: abc123-...)
# or
✓ Existing Google user logged in: user@gmail.com
# or
✓ Linked Google account to existing user: user@gmail.com
```

### Test 2: Verify User Created with UUID

```bash
# Check database
docker exec secondlayer-postgres psql -U financemanager -d payments_db -c "SELECT id, email, name, google_id, email_verified FROM users ORDER BY created_at DESC LIMIT 5;"
```

**Expected Output:**
```
                  id                  |        email        |      name       |   google_id    | email_verified
--------------------------------------+---------------------+-----------------+----------------+----------------
 abc123-def4-5678-90ab-cdef12345678  | user@gmail.com      | John Doe        | 1234567890     | t
```

✅ **Each user has unique UUID in `id` column!**

### Test 3: User Linking (Existing Email)

1. **Register with email/password first:**
```bash
curl -X POST http://localhost:3001/api/auth/register \
  -H 'Content-Type: application/json' \
  -d '{"email":"test@gmail.com","password":"test123","name":"Test User"}' | jq .
```

2. **Login with Google using same email:**
```bash
open "http://localhost:3001/api/auth/google"
# Use test@gmail.com Google account
```

3. **Verify accounts linked:**
```bash
docker exec secondlayer-postgres psql -U financemanager -d payments_db -c "SELECT id, email, password_hash IS NOT NULL as has_password, google_id IS NOT NULL as has_google FROM users WHERE email='test@gmail.com';"
```

**Expected:**
```
 has_password | has_google
--------------+------------
 t            | t
```

✅ **Same user can login with email OR Google!**

---

## 🎨 Frontend Integration

### Update index.html Google Button

Edit `/Users/vovkes/ZOMCP/SecondLayer/buytoken/index.html`:

```html
<!-- Change this: -->
<button class="btn btn-outline btn-lg btn-full" style="gap: 12px;">
  Continue with Google
</button>

<!-- To this: -->
<a href="/api/auth/google" class="btn btn-outline btn-lg btn-full" style="gap: 12px;">
  <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
    <!-- Google icon SVG -->
  </svg>
  Continue with Google
</a>
```

### Handle OAuth Callback in Frontend

Create `/Users/vovkes/ZOMCP/SecondLayer/buytoken/public/js/auth.js`:

```javascript
// Check if redirected from OAuth with token
const urlParams = new URLSearchParams(window.location.search);
const token = urlParams.get('token');
const uid = urlParams.get('uid');
const email = urlParams.get('email');
const balance = urlParams.get('balance');

if (token) {
  // Save token to localStorage
  localStorage.setItem('auth_token', token);
  localStorage.setItem('user_id', uid);
  localStorage.setItem('user_email', email);
  localStorage.setItem('token_balance', balance);

  // Clear URL parameters
  window.history.replaceState({}, document.title, window.location.pathname);

  // Show welcome message
  console.log(`✓ Logged in as ${email} (UID: ${uid})`);
  console.log(`Balance: ${balance} tokens`);

  // Update UI
  // ... your UI update code
}
```

---

## 📊 OAuth2 Flow Diagram

```
User clicks "Continue with Google"
         ↓
GET /api/auth/google
         ↓
Redirect to Google Login
         ↓
User approves scopes
         ↓
Google redirects to /api/auth/google/callback?code=...
         ↓
Passport verifies code with Google
         ↓
┌─────────────────────────────────┐
│ Check if user exists by:        │
│ 1. Google ID                    │
│ 2. Email address                │
└─────────────────────────────────┘
         ↓
┌─────────────────────────────────┐
│ User exists? → Login            │
│ Email exists? → Link accounts   │
│ New user? → Create with UUID    │
└─────────────────────────────────┘
         ↓
Generate JWT token
         ↓
Redirect to /profile.html?token=xxx&uid=xxx
         ↓
Frontend saves token, shows user profile
```

---

## 🔍 Debugging

### Check OAuth2 Configuration

```bash
# Verify .env has real credentials
cat .env | grep GOOGLE

# Should show:
# GOOGLE_CLIENT_ID=12345-abcde.apps.googleusercontent.com
# GOOGLE_CLIENT_SECRET=GOCSPX-abc123...
```

### Enable Debug Logging

Add to `src/config/passport.ts`:

```typescript
passport.use(
  new GoogleStrategy(
    {
      clientID: GOOGLE_CLIENT_ID,
      clientSecret: GOOGLE_CLIENT_SECRET,
      callbackURL: GOOGLE_CALLBACK_URL,
      scope: ['profile', 'email'],
    },
    async (accessToken, refreshToken, profile, done) => {
      console.log('🔍 Google Profile:', profile); // Add this
      // ... rest of code
    }
  )
);
```

### Common Issues

**Issue**: "Error: redirect_uri_mismatch"
**Fix**: Ensure callback URL in Google Console exactly matches:
```
http://localhost:3001/api/auth/google/callback
```

**Issue**: "Error: invalid_client"
**Fix**: Check GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET in .env

**Issue**: "User not created"
**Fix**: Check database logs:
```bash
docker logs secondlayer-postgres
```

---

## ✅ Verification Checklist

- [ ] OAuth Consent Screen configured
- [ ] OAuth Client ID created
- [ ] Credentials added to .env file
- [ ] Server restarted with new config
- [ ] Test OAuth flow (click "Continue with Google")
- [ ] User created with UUID in database
- [ ] JWT token returned to frontend
- [ ] Email verified automatically (email_verified=true)
- [ ] User can login again with same Google account
- [ ] Account linking works (email + Google)

---

## 🎯 Unique UID Implementation

**How UIDs are Generated:**
```sql
-- Database default function
id UUID PRIMARY KEY DEFAULT gen_random_uuid()
```

**Example UID:**
```
a1b2c3d4-e5f6-4789-ab12-cd34ef567890
```

**Usage in Billing:**
```typescript
// Create invoice for user
const invoice = await pool.query(
  'INSERT INTO invoices (user_id, amount_usd) VALUES ($1, $2)',
  [user.id, 10.00] // user.id is the UUID
);

// Track token usage
const transaction = await pool.query(
  'INSERT INTO token_transactions (user_id, type, amount) VALUES ($1, $2, $3)',
  [user.id, 'usage', -100] // Deduct 100 tokens
);
```

**Verify UUID Uniqueness:**
```sql
-- Check for duplicate UUIDs (should return 0)
SELECT id, COUNT(*) FROM users GROUP BY id HAVING COUNT(*) > 1;
```

---

## 🚀 Production Considerations

### Security Enhancements

1. **Use HTTPS** (required by Google OAuth2):
```
GOOGLE_CALLBACK_URL=https://your-domain.com/api/auth/google/callback
```

2. **httpOnly Cookies** (instead of URL tokens):
```typescript
res.cookie('auth_token', token, {
  httpOnly: true,
  secure: true, // HTTPS only
  sameSite: 'lax',
  maxAge: 7 * 24 * 60 * 60 * 1000 // 7 days
});
res.redirect('/profile.html');
```

3. **State Parameter** (CSRF protection):
```typescript
const state = crypto.randomBytes(16).toString('hex');
// Save state to session, verify in callback
```

4. **Approved Production Domains**:
   - Add your domain to Google Console
   - Update authorized origins and redirect URIs

---

## 📞 Support

**Issues**: Check server logs for errors
**Database**: `docker exec -it secondlayer-postgres psql -U financemanager -d payments_db`
**Server**: Running on http://localhost:3001

**Test Account**: shepherdvovkes@gmail.com (already a test user)

---

**Status**: ✅ READY TO TEST
**Next Step**: Create OAuth2 credentials in Google Console and update .env file!
