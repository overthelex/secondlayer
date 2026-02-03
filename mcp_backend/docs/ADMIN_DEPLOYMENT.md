# Admin Billing System Deployment Guide

**Purpose:** Deploy the admin billing dashboard to `dev.billing.legal.org.ua` for managing all MCP server users.

**Status:** ✅ Backend API Implemented | ⏳ Frontend Pending

---

## Overview

The admin billing system consists of:

1. **Backend API** (`admin-routes.ts`) - ✅ Implemented
2. **Frontend Dashboard** (React app) - ⏳ To be built
3. **Database** (existing tables + views) - ✅ Ready
4. **Authentication** (JWT + admin role) - ⚠️ Role check pending

---

## Backend API Endpoints

All endpoints are mounted at `/api/admin/*` and require JWT authentication.

### Dashboard & Statistics
- `GET /api/admin/stats/overview` - Dashboard overview
- `GET /api/admin/stats/revenue-chart` - Revenue chart data
- `GET /api/admin/stats/tier-distribution` - User tier distribution

### User Management
- `GET /api/admin/users` - List all users (with filters)
- `GET /api/admin/users/:userId` - Get user details
- `PUT /api/admin/users/:userId/tier` - Update user pricing tier
- `POST /api/admin/users/:userId/adjust-balance` - Adjust user balance
- `PUT /api/admin/users/:userId/limits` - Update spending limits

### Transaction Management
- `GET /api/admin/transactions` - List all transactions
- `POST /api/admin/transactions/:transactionId/refund` - Refund transaction

### Analytics
- `GET /api/admin/analytics/cohorts` - Cohort analysis
- `GET /api/admin/analytics/usage` - Usage analytics by tool

### System Settings
- `GET /api/admin/settings` - Get system settings
- `GET /api/admin/api-keys` - List API keys (not yet implemented)

---

## Deployment Steps

### Phase 1: Backend API (✅ Complete)

1. **Files Created:**
   - `mcp_backend/src/routes/admin-routes.ts` - Admin API routes
   - `mcp_backend/docs/admin-dashboard-frontend.tsx` - React components template
   - `mcp_backend/docs/admin-api-demo.html` - HTML demo for testing
   - `mcp_backend/docs/ADMIN_DEPLOYMENT.md` - This file

2. **Integration:**
   - Added import in `http-server.ts`
   - Mounted routes at `/api/admin`
   - Uses existing `requireJWT` middleware

3. **Testing:**
   - Open `mcp_backend/docs/admin-api-demo.html` in browser
   - Enter API URL: `https://dev.legal.org.ua`
   - Enter JWT token from login
   - Test all endpoints

### Phase 2: Admin Role Check (⏳ Next)

Currently, admin routes accept any authenticated user. We need to:

1. **Add `is_admin` column to `users` table:**

```sql
-- Run on DEV database
ALTER TABLE users ADD COLUMN is_admin BOOLEAN DEFAULT false;

-- Set your user as admin
UPDATE users SET is_admin = true WHERE email = 'your-email@example.com';
```

2. **Update admin middleware in `admin-routes.ts`:**

Replace the TODO section at line 29 with:

```typescript
const requireAdmin = async (req: Request, res: Response, next: any) => {
  const user = (req as any).user;
  if (!user) {
    return res.status(401).json({ error: 'Authentication required' });
  }

  // Check if user has admin role
  const result = await db.query('SELECT is_admin FROM users WHERE id = $1', [user.id]);
  if (!result.rows[0]?.is_admin) {
    logger.warn('Non-admin user attempted to access admin endpoint', {
      userId: user.id,
      email: user.email,
      endpoint: req.path
    });
    return res.status(403).json({ error: 'Admin access required' });
  }

  next();
};
```

### Phase 3: Frontend Deployment (⏳ To Do)

#### Option A: Separate React App (Recommended)

**Advantages:**
- Clean separation of concerns
- Easy to scale and maintain
- Can use modern React ecosystem
- Separate deployment pipeline

**Steps:**

1. **Create React App:**

```bash
cd /path/to/secondlayer
npx create-react-app admin-dashboard --template typescript
cd admin-dashboard
npm install axios recharts react-router-dom @types/recharts
```

2. **Copy Components:**

Copy components from `mcp_backend/docs/admin-dashboard-frontend.tsx` to React app:

```
admin-dashboard/
├── src/
│   ├── components/
│   │   ├── Dashboard.tsx
│   │   ├── UserManagement.tsx
│   │   ├── TransactionList.tsx
│   │   └── Analytics.tsx
│   ├── services/
│   │   └── api.ts
│   ├── App.tsx
│   └── index.tsx
├── package.json
└── README.md
```

3. **Configure API:**

In `src/services/api.ts`:

```typescript
const API_BASE_URL = process.env.REACT_APP_API_URL || 'https://dev.legal.org.ua';
```

4. **Build and Deploy:**

```bash
npm run build

# Deploy to dev.billing.legal.org.ua
# Option 1: Static hosting (Netlify, Vercel)
# Option 2: Nginx on gate server
```

#### Option B: Integrate into Existing lexwebapp

**Advantages:**
- Single deployment
- Shared authentication
- Reuse existing components

**Steps:**

1. Add admin routes to lexwebapp
2. Create admin components
3. Add admin menu item (visible only to admins)
4. Deploy with main app

---

## Nginx Configuration

### For Separate React App

Add to gateway server nginx config:

```nginx
# Admin Dashboard
server {
    listen 443 ssl http2;
    server_name dev.billing.legal.org.ua;

    ssl_certificate /etc/letsencrypt/live/legal.org.ua/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/legal.org.ua/privkey.pem;

    root /var/www/admin-dashboard/build;
    index index.html;

    # React Router - serve index.html for all routes
    location / {
        try_files $uri $uri/ /index.html;
    }

    # API proxy to backend
    location /api/ {
        proxy_pass http://localhost:3003/api/;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_cache_bypass $http_upgrade;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }

    # Security headers
    add_header X-Frame-Options "SAMEORIGIN" always;
    add_header X-Content-Type-Options "nosniff" always;
    add_header X-XSS-Protection "1; mode=block" always;
}
```

### Apply Configuration

```bash
# Test config
ssh gate "sudo nginx -t"

# Reload
ssh gate "sudo systemctl reload nginx"

# Get SSL cert (if not exists)
ssh gate "sudo certbot --nginx -d dev.billing.legal.org.ua"
```

---

## Testing the Admin API

### 1. Using HTML Demo

Open `mcp_backend/docs/admin-api-demo.html` in browser:

1. Enter API URL: `https://dev.legal.org.ua`
2. Get JWT token:
   - Login at `https://dev.legal.org.ua/auth/google`
   - Check response for `access_token`
3. Paste JWT token
4. Click "Load Dashboard"
5. Test all tabs

### 2. Using curl

```bash
# Set your JWT token
JWT="your-jwt-token-here"
API="https://dev.legal.org.ua"

# Get dashboard stats
curl -H "Authorization: Bearer $JWT" \
  "$API/api/admin/stats/overview" | jq

# List users
curl -H "Authorization: Bearer $JWT" \
  "$API/api/admin/users?limit=10" | jq

# Get user details
curl -H "Authorization: Bearer $JWT" \
  "$API/api/admin/users/USER_ID_HERE" | jq

# Adjust balance
curl -X POST \
  -H "Authorization: Bearer $JWT" \
  -H "Content-Type: application/json" \
  -d '{"amount": 10.00, "reason": "Test credit"}' \
  "$API/api/admin/users/USER_ID_HERE/adjust-balance" | jq

# Update tier
curl -X PUT \
  -H "Authorization: Bearer $JWT" \
  -H "Content-Type: application/json" \
  -d '{"tier": "business"}' \
  "$API/api/admin/users/USER_ID_HERE/tier" | jq

# Get transactions
curl -H "Authorization: Bearer $JWT" \
  "$API/api/admin/transactions?limit=20" | jq

# Get cohort analytics
curl -H "Authorization: Bearer $JWT" \
  "$API/api/admin/analytics/cohorts" | jq

# Get usage analytics
curl -H "Authorization: Bearer $JWT" \
  "$API/api/admin/analytics/usage?days=7" | jq
```

### 3. Using Postman

Import collection:

```json
{
  "info": {
    "name": "SecondLayer Admin API",
    "schema": "https://schema.getpostman.com/json/collection/v2.1.0/collection.json"
  },
  "auth": {
    "type": "bearer",
    "bearer": [
      {
        "key": "token",
        "value": "{{jwt_token}}",
        "type": "string"
      }
    ]
  },
  "variable": [
    {
      "key": "base_url",
      "value": "https://dev.legal.org.ua",
      "type": "string"
    },
    {
      "key": "jwt_token",
      "value": "",
      "type": "string"
    }
  ],
  "item": [
    {
      "name": "Dashboard Stats",
      "request": {
        "method": "GET",
        "header": [],
        "url": {
          "raw": "{{base_url}}/api/admin/stats/overview",
          "host": ["{{base_url}}"],
          "path": ["api", "admin", "stats", "overview"]
        }
      }
    },
    {
      "name": "List Users",
      "request": {
        "method": "GET",
        "header": [],
        "url": {
          "raw": "{{base_url}}/api/admin/users?limit=20",
          "host": ["{{base_url}}"],
          "path": ["api", "admin", "users"],
          "query": [
            {
              "key": "limit",
              "value": "20"
            }
          ]
        }
      }
    }
  ]
}
```

---

## Security Considerations

### 1. Admin Role Verification

**Current Status:** ⚠️ Any authenticated user can access admin endpoints

**Fix Required:**
- Add `is_admin` column to users table
- Implement role check in middleware (see Phase 2)
- Audit log all admin actions

### 2. Rate Limiting

Add rate limiting to admin endpoints:

```typescript
import rateLimit from 'express-rate-limit';

const adminRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100, // Limit each IP to 100 requests per windowMs
  message: 'Too many requests from this IP',
});

router.use(adminRateLimiter);
```

### 3. Audit Logging

Log all admin actions:

```typescript
// After each admin action
await db.query(`
  INSERT INTO admin_audit_log (admin_id, action, target_user_id, details)
  VALUES ($1, $2, $3, $4)
`, [adminId, 'adjust_balance', userId, JSON.stringify({ amount, reason })]);
```

Create audit table:

```sql
CREATE TABLE admin_audit_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  admin_id UUID REFERENCES users(id),
  action VARCHAR(50) NOT NULL,
  target_user_id UUID REFERENCES users(id),
  details JSONB,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_audit_admin ON admin_audit_log(admin_id, created_at);
CREATE INDEX idx_audit_target ON admin_audit_log(target_user_id, created_at);
```

### 4. CORS Configuration

Restrict CORS to admin domain:

```typescript
const adminCorsOptions = {
  origin: 'https://dev.billing.legal.org.ua',
  credentials: true,
};

router.use(cors(adminCorsOptions));
```

---

## Monitoring & Alerts

### 1. Setup Alerts

Monitor critical admin actions:

```typescript
// In admin-routes.ts
import { sendAdminAlert } from '../utils/alerts.js';

// After balance adjustment
if (Math.abs(amount) > 100) {
  await sendAdminAlert({
    type: 'large_balance_adjustment',
    admin: adminUser.email,
    user: userId,
    amount,
    reason,
  });
}
```

### 2. Dashboard Metrics

Track admin activity:
- Balance adjustments per day
- Tier changes per day
- Refunds issued
- Failed admin API calls

---

## Troubleshooting

### Issue: 401 Unauthorized

**Cause:** Invalid or expired JWT token

**Fix:**
1. Login again at `https://dev.legal.org.ua/auth/google`
2. Copy new access_token
3. Update JWT in demo page or curl commands

### Issue: 403 Forbidden

**Cause:** User is not admin

**Fix:**
```sql
-- Check admin status
SELECT email, is_admin FROM users WHERE email = 'your-email@example.com';

-- Grant admin access
UPDATE users SET is_admin = true WHERE email = 'your-email@example.com';
```

### Issue: CORS Error

**Cause:** Frontend domain not allowed

**Fix:**
```typescript
// In http-server.ts
this.app.use(cors({
  origin: [
    'https://dev.legal.org.ua',
    'https://dev.billing.legal.org.ua',  // Add this
  ],
  credentials: true,
}));
```

### Issue: Nginx 502 Bad Gateway

**Cause:** Backend not running

**Fix:**
```bash
# Check backend status
ssh gate "docker ps | grep secondlayer"

# Check logs
ssh gate "docker logs secondlayer-backend-dev"

# Restart if needed
ssh gate "cd /home/vovkes/deployment && ./manage-gateway.sh restart dev"
```

---

## Next Steps

1. ✅ **Backend API** - Implemented
2. ⏳ **Add admin role check** - See Phase 2
3. ⏳ **Build React frontend** - See Phase 3
4. ⏳ **Deploy to dev.billing.legal.org.ua**
5. ⏳ **Test all features**
6. ⏳ **Add audit logging**
7. ⏳ **Setup monitoring & alerts**
8. ⏳ **Deploy to production** (billing.legal.org.ua)

---

## Resources

- **API Endpoints Documentation:** `/mcp_backend/docs/ADMIN_BILLING_DESIGN.md`
- **React Components Template:** `/mcp_backend/docs/admin-dashboard-frontend.tsx`
- **HTML Demo:** `/mcp_backend/docs/admin-api-demo.html`
- **Backend Routes:** `/mcp_backend/src/routes/admin-routes.ts`

---

**Last Updated:** 2026-02-01
**Maintainers:** SecondLayer Team
**Status:** Backend Complete, Frontend Pending
