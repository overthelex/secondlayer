# Phase 3 Billing Implementation Plan
## Frontend Dashboard, Production Payments & Operations

**Timeline:** 4-6 weeks
**Dependencies:** Phase 1 ✅ Complete, Phase 2 ✅ Complete (backend)
**Priority:** High (monetization ready)

---

## Executive Summary

Phase 3 completes the billing system by adding:
1. **User-facing frontend dashboard** at billing.legal.org.ua
2. **Production payment setup** (real Stripe/Fondy credentials, webhook configuration)
3. **Operational monitoring** (analytics, alerts, admin tools)
4. **Compliance features** (invoices, receipts, tax handling)

After Phase 3, the platform will be **monetization-ready** with full self-service billing.

---

## Current State Analysis

### ✅ Phase 1 Achievements
- Core billing infrastructure (database, services, API)
- Automatic cost tracking and charging
- Balance and limit enforcement
- Transaction history
- Billing API endpoints (`/api/billing/*`)

### ✅ Phase 2 Achievements
- Payment provider integration (Stripe + Fondy)
- Mock services for testing
- Email notifications (templates ready)
- Pre-flight balance checks (402/429 responses)
- Webhook handlers with signature verification
- Database migration 012 (payment_intents table)

### ⚠️ Phase 2 Gaps (Frontend & Deployment)
The following items from Phase 2 document remain incomplete:
- **Part 2: Frontend Implementation** (Section 2.1-2.3)
- **Part 3: Deployment** (Docker, Nginx, SSL)

### 🔴 Critical Missing Features
1. No user interface for billing (users can't see balance/top-up)
2. Mock payment services in production (no real payments possible)
3. No monitoring/alerting for payment failures
4. No admin tools for support team
5. No invoice/receipt generation

---

## Part 1: Frontend Dashboard (Weeks 1-3)

### Priority: **CRITICAL**
Users currently have no way to:
- View their balance
- Top up funds
- See transaction history
- Monitor spending

### 1.1 Project Setup

**Directory:** `/billing-frontend/` (at repo root, peer to mcp_backend)

**Tech Stack:**
- **Framework:** React 18 + TypeScript 5
- **Build:** Vite 5
- **Styling:** Tailwind CSS 3 + shadcn/ui components
- **State:** React Query 4 (TanStack Query)
- **Forms:** React Hook Form 7
- **Payments:** @stripe/stripe-js, @stripe/react-stripe-js
- **Charts:** Recharts (for spending analytics)
- **Date:** date-fns 3
- **Icons:** lucide-react

### 1.2 Core Pages

#### Dashboard (`/dashboard`)
**Purpose:** Overview of billing status

**Components:**
- `BalanceCard` - Current balance (USD/UAH), visual indicator (green/yellow/red)
- `SpendingLimitsCard` - Daily/monthly progress bars with percentages
- `QuickTopUpButton` - Prominent CTA for adding funds
- `RecentTransactionsTable` - Last 5 transactions with drill-down
- `UsageChart` - 30-day spending trend (line chart)
- `CostBreakdownPie` - Spending by tool type (pie chart)

**API Calls:**
- `GET /api/billing/balance` - Balance, limits, usage stats
- `GET /api/billing/history?limit=5` - Recent transactions
- `GET /api/billing/analytics/monthly` - Chart data

#### Top-Up Page (`/topup`)
**Purpose:** Add funds to account

**Features:**
- Amount selector (predefined: $5, $10, $25, $50, $100, Custom)
- Currency toggle (USD via Stripe, UAH via Fondy)
- Payment method selector with icons/logos
- **Stripe flow:**
  - Embed Stripe Elements (CardElement)
  - Client-side payment confirmation
  - Success/error handling with animation
- **Fondy flow:**
  - Redirect to Fondy checkout
  - Return URL handling
  - Status polling while waiting

**Security:**
- PCI compliance via Stripe Elements (no card data touches our server)
- Fondy redirect (similar security model)
- Payment intent idempotency (prevent double charges)

#### Transaction History (`/transactions`)
**Purpose:** Complete transaction log with filtering

**Features:**
- Paginated table (50 per page)
- Filters:
  - Date range picker (last 7/30/90 days, custom)
  - Transaction type (all, charge, topup, refund, adjustment)
  - Amount range (min/max)
  - Search by description
- Export to CSV (client-side)
- Columns:
  - Date/time (formatted, sortable)
  - Type (icon + label)
  - Amount (color-coded: red for charges, green for topups)
  - Balance before/after
  - Description (truncated, expandable)
  - Request ID (linkable to logs if admin)

**API Calls:**
- `GET /api/billing/history?limit=50&offset=0&type=charge&from=...&to=...`

#### Settings Page (`/settings`)
**Purpose:** Manage billing preferences

**Features:**
- **Spending Limits:**
  - Daily limit slider (min $1, max $500)
  - Monthly limit slider (min $10, max $5000)
  - Save button with validation
- **Notifications:**
  - Email alerts toggle (low balance, payment success/failure)
  - Alert threshold slider (notify when balance < $X)
- **Payment Methods:**
  - Saved Stripe customer ID (display only)
  - Saved Fondy customer ID (display only)
- **Account Status:**
  - Billing enabled/disabled toggle (admin only)
  - Total lifetime spending (read-only)
  - Account creation date

**API Calls:**
- `PUT /api/billing/settings` - Update limits and preferences

### 1.3 Authentication Flow

**OAuth Integration:**
```typescript
// src/auth/GoogleAuth.tsx
const handleGoogleLogin = () => {
  window.location.href = `${API_BASE_URL}/auth/google`;
};

// Callback handler
useEffect(() => {
  const urlParams = new URLSearchParams(window.location.search);
  const token = urlParams.get('jwt');
  if (token) {
    localStorage.setItem('jwt_token', token);
    navigate('/dashboard');
  }
}, []);
```

**Protected Routes:**
```typescript
<Route element={<ProtectedRoute />}>
  <Route path="/dashboard" element={<Dashboard />} />
  <Route path="/topup" element={<TopUp />} />
  <Route path="/transactions" element={<Transactions />} />
  <Route path="/settings" element={<Settings />} />
</Route>
```

### 1.4 API Client Setup

**File:** `src/api/client.ts`

```typescript
import axios from 'axios';

export const apiClient = axios.create({
  baseURL: import.meta.env.VITE_API_URL || 'https://mcp.legal.org.ua',
  headers: { 'Content-Type': 'application/json' },
});

// Attach JWT token
apiClient.interceptors.request.use((config) => {
  const token = localStorage.getItem('jwt_token');
  if (token) config.headers.Authorization = `Bearer ${token}`;
  return config;
});

// Handle 401 (expired token)
apiClient.interceptors.response.use(
  (response) => response,
  (error) => {
    if (error.response?.status === 401) {
      localStorage.removeItem('jwt_token');
      window.location.href = '/login';
    }
    return Promise.reject(error);
  }
);
```

### 1.5 Deployment

**Docker Setup:**
```dockerfile
# billing-frontend/Dockerfile
FROM node:20-alpine AS builder
WORKDIR /app
COPY package*.json ./
RUN npm ci --only=production
COPY . .
RUN npm run build

FROM nginx:alpine
COPY --from=builder /app/dist /usr/share/nginx/html
COPY nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 80
CMD ["nginx", "-g", "daemon off;"]
```

**Nginx Config:**
```nginx
# billing-frontend/nginx.conf
server {
    listen 80;
    server_name _;
    root /usr/share/nginx/html;
    index index.html;

    # SPA routing - all routes go to index.html
    location / {
        try_files $uri $uri/ /index.html;
    }

    # Cache busting for assets
    location ~* \.(js|css|png|jpg|jpeg|gif|ico|svg|woff2)$ {
        expires 1y;
        add_header Cache-Control "public, immutable";
    }

    # Security headers
    add_header X-Frame-Options "SAMEORIGIN" always;
    add_header X-Content-Type-Options "nosniff" always;
    add_header X-XSS-Protection "1; mode=block" always;
}
```

**Docker Compose:**
```yaml
# deployment/docker-compose.billing.yml
services:
  billing-frontend:
    build:
      context: ../billing-frontend
      dockerfile: Dockerfile
    image: billing-frontend:latest
    container_name: billing-frontend-prod
    restart: unless-stopped
    ports:
      - "8092:80"
    environment:
      - NODE_ENV=production
      - VITE_API_URL=https://mcp.legal.org.ua
    networks:
      - secondlayer-network

networks:
  secondlayer-network:
    external: true
```

**Gate Server Setup:**
```nginx
# /etc/nginx/sites-available/billing.legal.org.ua
server {
    listen 80;
    listen [::]:80;
    server_name billing.legal.org.ua;
    return 301 https://$server_name$request_uri;
}

server {
    listen 443 ssl http2;
    listen [::]:443 ssl http2;
    server_name billing.legal.org.ua;

    ssl_certificate /etc/letsencrypt/live/legal.org.ua/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/legal.org.ua/privkey.pem;

    location / {
        proxy_pass http://localhost:8092;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

**SSL Certificate:**
```bash
sudo certbot certonly --nginx \
  -d legal.org.ua \
  -d billing.legal.org.ua \
  -d mcp.legal.org.ua \
  --cert-name legal.org.ua
```

---

## Part 2: Production Payment Setup (Week 3)

### Priority: **HIGH**
Currently using mock services - need real payment processing.

### 2.1 Stripe Production Setup

**Steps:**
1. **Upgrade Stripe account** to production mode
   - Verify business details
   - Add bank account for payouts
   - Submit tax information (W-8BEN for non-US)

2. **Get production API keys:**
   - Secret key: `sk_live_...`
   - Publishable key: `pk_live_...`
   - Update `.env.prod` on gate server

3. **Configure webhooks:**
   - Dashboard → Webhooks → Add endpoint
   - URL: `https://mcp.legal.org.ua/webhooks/stripe`
   - Events to listen:
     - `payment_intent.succeeded`
     - `payment_intent.payment_failed`
     - `payment_intent.canceled`
   - Copy webhook secret: `whsec_...`
   - Update `.env.prod`

4. **Test with real card:**
   - Use personal card, charge $0.50
   - Verify webhook received
   - Verify balance updated
   - Verify transaction recorded
   - Verify email sent

5. **Set up Stripe billing portal** (optional):
   - For users to manage payment methods
   - Automatic invoice generation
   - Payment method updates

### 2.2 Fondy Production Setup

**Steps:**
1. **Register Fondy account:**
   - Visit https://portal.fondy.eu/
   - Complete KYC (business verification)
   - Wait for approval (2-5 business days)

2. **Get production credentials:**
   - Merchant ID: `1234567`
   - Secret Key: `<production_key>`
   - Update `.env.prod`

3. **Configure callback URL:**
   - Dashboard → Settings → Server callback URL
   - URL: `https://mcp.legal.org.ua/webhooks/fondy`
   - Ensure signature verification enabled

4. **Test with real UAH card:**
   - Use Ukrainian card, charge 10 UAH (~$0.27)
   - Verify callback received
   - Verify balance updated (USD conversion)
   - Verify transaction recorded

5. **Configure UAH→USD exchange rate:**
   - Option 1: Manual (update `UAH_TO_USD_RATE` in .env)
   - Option 2: Automatic (integrate with API like https://bank.gov.ua/NBUStatService/)

### 2.3 SMTP Production Setup

**Current State:** EmailService in development mode (logs to console)

**Production Setup:**

**Option 1: Gmail (Simple, for low volume)**
```bash
EMAIL_FROM=noreply@legal.org.ua
SMTP_HOST=smtp.gmail.com
SMTP_PORT=587
SMTP_SECURE=false
SMTP_USER=your-email@gmail.com
SMTP_PASS=<app_password>  # Generate at myaccount.google.com/apppasswords
```

**Option 2: SendGrid (Recommended, for high volume)**
```bash
EMAIL_FROM=noreply@legal.org.ua
SMTP_HOST=smtp.sendgrid.net
SMTP_PORT=587
SMTP_SECURE=false
SMTP_USER=apikey
SMTP_PASS=<sendgrid_api_key>
```

**Option 3: AWS SES (Scalable)**
```bash
EMAIL_FROM=noreply@legal.org.ua
SMTP_HOST=email-smtp.eu-west-1.amazonaws.com
SMTP_PORT=587
SMTP_SECURE=false
SMTP_USER=<aws_access_key_id>
SMTP_PASS=<aws_secret_access_key>
```

**Email Domain Setup:**
- Add SPF record: `v=spf1 include:_spf.google.com ~all`
- Add DKIM record (from provider)
- Add DMARC record: `v=DMARC1; p=none; rua=mailto:admin@legal.org.ua`

**Test emails:**
```bash
curl -X POST https://mcp.legal.org.ua/api/billing/test-email \
  -H "Authorization: Bearer $ADMIN_JWT" \
  -H "Content-Type: application/json" \
  -d '{"email": "your-email@example.com"}'
```

---

## Part 3: Monitoring & Analytics (Week 4)

### Priority: **MEDIUM**
Essential for operations, but business can run without it initially.

### 3.1 Payment Analytics Dashboard (Backend API)

**New Endpoints:**

**GET `/api/admin/analytics/payments`** (Admin only)
```json
{
  "period": "30d",
  "revenue": {
    "total_usd": 1234.56,
    "total_uah": 45678.00,
    "stripe_usd": 1000.00,
    "fondy_uah": 45678.00
  },
  "transactions": {
    "total_count": 523,
    "successful": 498,
    "failed": 25,
    "success_rate": 0.952
  },
  "by_day": [
    { "date": "2026-01-28", "revenue_usd": 45.67, "count": 12 }
  ]
}
```

**GET `/api/admin/analytics/users`** (Admin only)
```json
{
  "total_users": 1523,
  "paying_users": 342,
  "average_balance_usd": 12.34,
  "average_spent_usd": 23.45,
  "top_spenders": [
    { "user_id": "...", "email": "...", "total_spent_usd": 234.56 }
  ]
}
```

**GET `/api/admin/analytics/tools`** (Admin only)
```json
{
  "by_tool": [
    {
      "tool_name": "get_court_decision",
      "request_count": 1234,
      "total_cost_usd": 45.67,
      "avg_cost_usd": 0.037
    }
  ]
}
```

### 3.2 Real-time Monitoring

**Metrics to Track:**
- Payment success rate (target: >95%)
- Webhook processing time (target: <2s)
- Balance check failures (insufficient balance)
- Failed payments by reason (declined, expired, etc.)
- Daily/monthly revenue trends

**Tools:**

**Option 1: Prometheus + Grafana**
```typescript
// src/utils/metrics.ts
import { Counter, Histogram, Gauge } from 'prom-client';

export const paymentSuccessCounter = new Counter({
  name: 'payments_successful_total',
  help: 'Total successful payments',
  labelNames: ['provider'],
});

export const paymentFailureCounter = new Counter({
  name: 'payments_failed_total',
  help: 'Total failed payments',
  labelNames: ['provider', 'reason'],
});

export const webhookProcessingTime = new Histogram({
  name: 'webhook_processing_seconds',
  help: 'Webhook processing time in seconds',
  labelNames: ['provider'],
  buckets: [0.1, 0.5, 1, 2, 5],
});

export const activeUsers = new Gauge({
  name: 'billing_active_users',
  help: 'Number of users with billing_enabled=true',
});
```

**Option 2: Datadog / New Relic** (Paid, easier setup)

### 3.3 Alerting

**Critical Alerts (PagerDuty/Slack):**
- Payment webhook failure rate >5% (5min window)
- Database connection failure
- Stripe/Fondy API errors
- SMTP errors (email sending failures)

**Warning Alerts (Email/Slack):**
- Payment success rate <95% (1hr window)
- Unusual spike in failed payments
- Webhook processing time >2s (p95)
- Users with negative balance (data integrity issue)

**Implementation:**
```typescript
// src/services/alert-service.ts
export class AlertService {
  async sendCriticalAlert(message: string, details: any) {
    // Option 1: Slack webhook
    await axios.post(process.env.SLACK_WEBHOOK_URL, {
      text: `🚨 CRITICAL: ${message}`,
      attachments: [{ text: JSON.stringify(details, null, 2) }],
    });

    // Option 2: Email to admin
    await this.emailService.sendAdminAlert(message, details);

    // Option 3: PagerDuty
    // await this.pagerduty.trigger(message, details);
  }
}
```

### 3.4 Logging Enhancements

**Structured Logging:**
```typescript
// Every payment event should log:
logger.info('Payment intent created', {
  event: 'payment.created',
  provider: 'stripe',
  user_id: userId,
  amount_usd: amount,
  payment_intent_id: paymentIntent.id,
  request_id: requestId,
  timestamp: new Date().toISOString(),
});

logger.info('Payment succeeded', {
  event: 'payment.succeeded',
  provider: 'stripe',
  user_id: userId,
  amount_usd: amount,
  payment_intent_id: paymentIntent.id,
  balance_before_usd: balanceBefore,
  balance_after_usd: balanceAfter,
  processing_time_ms: processingTime,
  timestamp: new Date().toISOString(),
});

logger.error('Payment failed', {
  event: 'payment.failed',
  provider: 'stripe',
  user_id: userId,
  amount_usd: amount,
  payment_intent_id: paymentIntent.id,
  error_code: error.code,
  error_message: error.message,
  timestamp: new Date().toISOString(),
});
```

**Log Aggregation:**
- Ship logs to Elasticsearch/Loki
- Create dashboards for common queries
- Set up log-based alerts

---

## Part 4: Admin Tools (Week 5)

### Priority: **MEDIUM**
Support team needs these to help users.

### 4.1 Admin Dashboard (New Frontend Route)

**Route:** `/admin` (admin users only)

**Pages:**

#### Admin Overview (`/admin/dashboard`)
- Total revenue (today, week, month, all-time)
- Active users count
- Pending payments count
- Failed payments count
- Recent support tickets

#### User Management (`/admin/users`)
- Search users by email/ID
- View user billing details
- Manual balance adjustment (with reason)
- Toggle billing_enabled flag
- View user's transaction history
- Impersonate user (for debugging)

#### Payment Management (`/admin/payments`)
- List all payments (filterable)
- Payment status (pending, succeeded, failed)
- Retry failed webhooks
- Manual refunds
- Payment method updates

#### Refund Tool (`/admin/refunds`)
- Search transaction by ID
- Preview refund details
- Execute refund (Stripe/Fondy API)
- Record refund transaction
- Send refund confirmation email

### 4.2 Admin API Endpoints

**Require admin role (new middleware: `requireAdmin`):**

```typescript
// src/middleware/require-admin.ts
export const requireAdmin = (req: DualAuthRequest, res: Response, next: NextFunction) => {
  if (req.authType !== 'jwt') {
    return res.status(403).json({ error: 'Admin access requires JWT authentication' });
  }

  if (req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Insufficient permissions' });
  }

  next();
};
```

**Endpoints:**

```typescript
// User management
POST /api/admin/users/:userId/adjust-balance
  { amount_usd: 10.00, reason: "Compensation for downtime" }

PUT /api/admin/users/:userId/billing-status
  { billing_enabled: false, reason: "Fraud suspected" }

// Payment management
POST /api/admin/payments/:paymentId/retry-webhook
POST /api/admin/payments/:paymentId/refund
  { amount_usd: 10.00, reason: "User request" }

// Analytics
GET /api/admin/analytics/payments?from=...&to=...
GET /api/admin/analytics/users
GET /api/admin/analytics/tools
GET /api/admin/analytics/revenue
```

### 4.3 Manual Operations Scripts

**Balance Adjustment:**
```bash
# scripts/adjust-balance.sh
#!/bin/bash
USER_ID=$1
AMOUNT_USD=$2
REASON=$3

curl -X POST https://mcp.legal.org.ua/api/admin/users/$USER_ID/adjust-balance \
  -H "Authorization: Bearer $ADMIN_JWT" \
  -H "Content-Type: application/json" \
  -d "{\"amount_usd\": $AMOUNT_USD, \"reason\": \"$REASON\"}"
```

**Bulk User Export:**
```sql
-- Export users with low balance for proactive outreach
COPY (
  SELECT
    u.email,
    u.name,
    ub.balance_usd,
    ub.total_spent_usd,
    ub.last_request_at
  FROM users u
  JOIN user_billing ub ON u.id = ub.user_id
  WHERE ub.balance_usd < 1.00
    AND ub.billing_enabled = true
  ORDER BY ub.last_request_at DESC
) TO '/tmp/low_balance_users.csv' CSV HEADER;
```

---

## Part 5: Compliance & Legal (Week 6)

### Priority: **HIGH for EU users**
Required for legal operation in EU/Ukraine.

### 5.1 Invoice Generation

**Requirements:**
- Sequential invoice numbers (INV-2026-00001)
- PDF generation with company logo
- VAT calculation (if applicable)
- User billing address
- Payment method details
- Store invoices for 7 years (compliance)

**Implementation:**

**New table:**
```sql
CREATE TABLE invoices (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  invoice_number VARCHAR(50) UNIQUE NOT NULL,
  user_id UUID NOT NULL REFERENCES users(id),
  transaction_id UUID NOT NULL REFERENCES billing_transactions(id),
  amount_usd DECIMAL(10,2) NOT NULL,
  amount_uah DECIMAL(10,2),
  vat_rate DECIMAL(5,2) DEFAULT 0.00,
  vat_amount_usd DECIMAL(10,2) DEFAULT 0.00,
  total_usd DECIMAL(10,2) NOT NULL,
  pdf_url TEXT,
  issued_at TIMESTAMPTZ DEFAULT NOW(),
  created_at TIMESTAMPTZ DEFAULT NOW()
);
```

**PDF Generation:**
```typescript
// src/services/invoice-service.ts
import PDFDocument from 'pdfkit';

export class InvoiceService {
  async generateInvoice(transactionId: string): Promise<string> {
    const tx = await this.getTransaction(transactionId);
    const user = await this.getUser(tx.user_id);

    const doc = new PDFDocument();
    const filename = `invoice-${tx.id}.pdf`;
    const stream = fs.createWriteStream(`/tmp/${filename}`);

    doc.pipe(stream);

    // Header
    doc.fontSize(20).text('INVOICE', { align: 'center' });
    doc.fontSize(10).text(`Invoice #: ${invoiceNumber}`);
    doc.text(`Date: ${new Date().toLocaleDateString()}`);

    // Company info
    doc.text('SecondLayer Legal Platform');
    doc.text('legal.org.ua');

    // Customer info
    doc.text(`Customer: ${user.name}`);
    doc.text(`Email: ${user.email}`);

    // Line items
    doc.text(`Description: ${tx.description}`);
    doc.text(`Amount: $${tx.amount_usd.toFixed(2)}`);
    if (tx.vat_amount_usd > 0) {
      doc.text(`VAT (${tx.vat_rate}%): $${tx.vat_amount_usd.toFixed(2)}`);
    }
    doc.fontSize(14).text(`Total: $${tx.total_usd.toFixed(2)}`);

    doc.end();

    return new Promise((resolve) => {
      stream.on('finish', () => {
        // Upload to S3 or local storage
        resolve(`/invoices/${filename}`);
      });
    });
  }
}
```

**API Endpoint:**
```typescript
GET /api/billing/invoices/:transactionId/pdf
  // Returns PDF file
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.send(pdfBuffer);
```

### 5.2 Tax Handling

**VAT for EU Customers:**
```typescript
// src/services/tax-service.ts
export class TaxService {
  getVatRate(country: string): number {
    const vatRates = {
      'UA': 0.20, // Ukraine 20%
      'PL': 0.23, // Poland 23%
      'DE': 0.19, // Germany 19%
      'FR': 0.20, // France 20%
      // ... other EU countries
    };
    return vatRates[country] || 0.00;
  }

  calculateVat(amountUsd: number, country: string): number {
    const rate = this.getVatRate(country);
    return amountUsd * rate;
  }
}
```

**Update payment creation:**
```typescript
// Before creating payment, calculate VAT
const vatRate = taxService.getVatRate(user.country);
const vatAmount = taxService.calculateVat(amountUsd, user.country);
const totalAmount = amountUsd + vatAmount;

// Store in payment_intents
await db.query(`
  INSERT INTO payment_intents (user_id, amount_usd, vat_rate, vat_amount_usd, total_usd)
  VALUES ($1, $2, $3, $4, $5)
`, [userId, amountUsd, vatRate, vatAmount, totalAmount]);
```

### 5.3 GDPR Compliance

**Right to Access:**
```typescript
GET /api/billing/export
  // Returns JSON with all user billing data
  {
    "user": { ... },
    "billing": { ... },
    "transactions": [ ... ],
    "payments": [ ... ],
    "invoices": [ ... ]
  }
```

**Right to Deletion:**
```typescript
DELETE /api/billing/delete-account
  // Soft delete: mark billing_enabled=false, anonymize PII
  // Keep transaction records for legal compliance (7 years)
  // Replace email with "deleted_user_<id>@deleted.local"
```

**Data Retention Policy:**
```sql
-- Auto-delete old payment intents (after 3 years)
DELETE FROM payment_intents
WHERE created_at < NOW() - INTERVAL '3 years'
  AND status IN ('succeeded', 'canceled');

-- Archive old transactions (after 7 years)
INSERT INTO billing_transactions_archive
SELECT * FROM billing_transactions
WHERE created_at < NOW() - INTERVAL '7 years';

DELETE FROM billing_transactions
WHERE created_at < NOW() - INTERVAL '7 years';
```

### 5.4 Terms of Service

**Add to frontend:**
- Refund policy (7-day money-back guarantee?)
- Pricing transparency (cost per tool)
- Fair usage policy
- Auto-renewal terms (if subscriptions added later)

**Database flag:**
```sql
ALTER TABLE users
ADD COLUMN tos_accepted_at TIMESTAMPTZ,
ADD COLUMN tos_version VARCHAR(10);
```

**Require TOS acceptance on first payment:**
```typescript
if (!user.tos_accepted_at) {
  return res.status(400).json({
    error: 'Terms of Service not accepted',
    tos_url: 'https://legal.org.ua/terms',
  });
}
```

---

## Part 6: Performance & Reliability (Week 6)

### 6.1 Webhook Reliability

**Problem:** Webhooks can fail due to network issues, timeouts, or bugs.

**Solution: Retry Logic**

```typescript
// src/services/webhook-queue.ts
import Bull from 'bull';

const webhookQueue = new Bull('webhooks', {
  redis: { host: 'localhost', port: 6379 },
});

webhookQueue.process(async (job) => {
  const { provider, payload, signature } = job.data;

  if (provider === 'stripe') {
    await stripeService.handleWebhook(payload, signature);
  } else if (provider === 'fondy') {
    await fondyService.handleCallback(payload);
  }
});

// Add job with retry
await webhookQueue.add(
  { provider: 'stripe', payload, signature },
  {
    attempts: 5,
    backoff: { type: 'exponential', delay: 2000 },
    removeOnComplete: true,
  }
);
```

**Webhook Status Table:**
```sql
CREATE TABLE webhook_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  provider VARCHAR(50) NOT NULL,
  event_id VARCHAR(255) NOT NULL,
  event_type VARCHAR(100) NOT NULL,
  payload JSONB NOT NULL,
  signature TEXT,
  status VARCHAR(50) NOT NULL, -- pending, processing, completed, failed
  attempts INT DEFAULT 0,
  last_error TEXT,
  processed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(provider, event_id)
);
```

### 6.2 Database Performance

**Indexes for common queries:**
```sql
-- Balance lookups (already exists, but verify)
CREATE INDEX IF NOT EXISTS idx_user_billing_user_id ON user_billing(user_id);

-- Transaction history pagination
CREATE INDEX IF NOT EXISTS idx_billing_transactions_user_created
  ON billing_transactions(user_id, created_at DESC);

-- Payment lookups
CREATE INDEX IF NOT EXISTS idx_payment_intents_user_status
  ON payment_intents(user_id, status);

-- Analytics queries
CREATE INDEX IF NOT EXISTS idx_billing_transactions_type_created
  ON billing_transactions(type, created_at);
```

**Connection Pooling:**
```typescript
// Verify pool size is appropriate
const pool = new Pool({
  max: 20, // max connections
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 2000,
});
```

### 6.3 Load Testing

**Scenario 1: Concurrent Payments**
```bash
# scripts/load-test-payments.sh
#!/bin/bash
for i in {1..100}; do
  curl -X POST https://mcp.legal.org.ua/api/billing/payment/stripe/create \
    -H "Authorization: Bearer $JWT_TOKEN" \
    -H "Content-Type: application/json" \
    -d '{"amount_usd": 10.00}' &
done
wait
```

**Scenario 2: Concurrent Webhooks**
```bash
# Simulate 50 webhooks arriving simultaneously
ab -n 50 -c 50 -T 'application/json' -p webhook.json \
  https://mcp.legal.org.ua/webhooks/stripe
```

**Target Performance:**
- Payment creation: <500ms (p95)
- Webhook processing: <2s (p95)
- Balance check: <100ms (p95)
- Transaction history: <1s for 50 records (p95)

### 6.4 Database Backup

**Automated backups:**
```bash
# cron job on gate server (daily at 2 AM)
0 2 * * * docker exec secondlayer-postgres-prod pg_dump -U secondlayer secondlayer_prod | gzip > /backups/billing_$(date +\%Y\%m\%d).sql.gz
```

**Backup retention:**
- Daily backups: Keep for 7 days
- Weekly backups: Keep for 4 weeks
- Monthly backups: Keep for 12 months

**Test restore:**
```bash
# Monthly restore test to verify backups work
gunzip < /backups/billing_20260128.sql.gz | docker exec -i secondlayer-postgres-test psql -U secondlayer test_db
```

---

## Part 7: User Experience Enhancements

### 7.1 Cost Estimates

**Show users estimated cost BEFORE they make a request:**

```typescript
// Frontend: Before calling tool
const { data } = await apiClient.post('/api/billing/estimate', {
  tool_name: 'get_court_decision',
  query: userQuery,
  reasoning_budget: 'standard',
});

// Show dialog:
// "This request will cost approximately $0.05"
// [Cancel] [Proceed]
```

**Backend endpoint:**
```typescript
POST /api/billing/estimate
  { tool_name: string, query_length?: number, reasoning_budget?: string }

  // Returns:
  {
    openai_estimated_tokens: 2000,
    openai_estimated_cost_usd: 0.004,
    zakononline_estimated_calls: 2,
    zakononline_estimated_cost_usd: 0.04,
    total_estimated_cost_usd: 0.044,
    estimation_notes: ["Basic court decision retrieval"]
  }
```

### 7.2 Low Balance Alerts

**Proactive alerts when balance < threshold:**

```typescript
// After each charge, check balance
if (newBalance < alertThreshold) {
  await emailService.sendLowBalanceAlert({
    email: user.email,
    name: user.name,
    balance: newBalance,
    currency: 'USD',
    topup_url: 'https://billing.legal.org.ua/topup',
  });

  // Update to avoid spam
  await db.query(`
    UPDATE user_billing
    SET last_alert_sent_at = NOW()
    WHERE user_id = $1
  `, [userId]);
}
```

**Configurable threshold:**
```typescript
// Settings page: "Alert me when balance drops below $ ___"
PUT /api/billing/settings
  { alert_threshold_usd: 5.00 }
```

### 7.3 Spending Recommendations

**Smart suggestions based on usage:**

```typescript
// "You've spent $15 in the last 30 days"
// "Consider topping up $25 to avoid interruptions"
// "Your current balance will last approximately X days based on usage"

const avgDailySpending = totalSpent / daysActive;
const daysRemaining = currentBalance / avgDailySpending;

if (daysRemaining < 7) {
  const recommendedTopup = Math.ceil(avgDailySpending * 30);
  // Show recommendation in dashboard
}
```

---

## Implementation Timeline

### Week 1: Frontend Core
- [ ] Initialize React project with Vite
- [ ] Setup routing and auth flow
- [ ] Create Dashboard page
- [ ] Create BalanceCard, LimitsCard components
- [ ] Integrate with existing billing API

### Week 2: Frontend Payment Pages
- [ ] Create TopUp page
- [ ] Integrate Stripe Elements
- [ ] Implement Fondy redirect flow
- [ ] Create Transactions page with filtering
- [ ] Create Settings page

### Week 3: Deployment & Production Setup
- [ ] Build Docker image for frontend
- [ ] Setup billing.legal.org.ua on gate server
- [ ] Configure SSL certificate
- [ ] Get production Stripe credentials
- [ ] Get production Fondy credentials
- [ ] Setup production SMTP
- [ ] Test end-to-end payment flow

### Week 4: Monitoring & Analytics
- [ ] Add structured logging to all payment events
- [ ] Setup Prometheus metrics
- [ ] Create Grafana dashboards
- [ ] Configure alerts (Slack/email)
- [ ] Add admin analytics endpoints

### Week 5: Admin Tools
- [ ] Create admin dashboard page
- [ ] Add user management features
- [ ] Add payment management features
- [ ] Implement refund tool
- [ ] Create admin API endpoints

### Week 6: Compliance & Reliability
- [ ] Implement invoice generation
- [ ] Add VAT calculation
- [ ] GDPR compliance features
- [ ] Webhook retry logic
- [ ] Database backup automation
- [ ] Load testing
- [ ] Performance optimization

---

## Success Criteria

Phase 3 is complete when:

### Frontend
- ✅ Users can view balance at billing.legal.org.ua
- ✅ Users can top up via Stripe or Fondy
- ✅ Users can view transaction history
- ✅ Users can adjust spending limits
- ✅ UI is responsive and accessible

### Payments
- ✅ Real Stripe payments working (not mock)
- ✅ Real Fondy payments working (not mock)
- ✅ Webhooks processing reliably (>99% success)
- ✅ Email notifications sent on all payment events
- ✅ Balance updates are atomic and accurate

### Operations
- ✅ Admin dashboard shows key metrics
- ✅ Alerts configured for critical failures
- ✅ Payment logs structured and searchable
- ✅ Refund tool functional
- ✅ Manual balance adjustments working

### Compliance
- ✅ Invoices generated for all payments
- ✅ VAT calculated for EU customers
- ✅ GDPR export/deletion working
- ✅ Terms of service enforced
- ✅ Data retention policy implemented

### Performance
- ✅ Payment creation <500ms (p95)
- ✅ Webhook processing <2s (p95)
- ✅ Balance check <100ms (p95)
- ✅ Frontend loads <2s (LCP)
- ✅ Database backups automated

---

## Risk Assessment

### High Risk
- **Payment provider account suspension** - Mitigation: Follow KYC requirements strictly
- **Webhook failures causing double-charges** - Mitigation: Idempotency checks in place
- **Database corruption during balance updates** - Mitigation: PostgreSQL transactions, regular backups

### Medium Risk
- **Frontend bugs preventing payments** - Mitigation: Extensive testing, staging environment
- **Exchange rate fluctuations (UAH→USD)** - Mitigation: Update rates daily, show disclaimer
- **SMTP provider rate limits** - Mitigation: Queue emails, use reputable provider

### Low Risk
- **Users don't trust payment system** - Mitigation: Clear security messaging, SSL badges
- **Admin tools too complex** - Mitigation: Iterative development, gather feedback
- **Performance degradation** - Mitigation: Load testing, monitoring, database optimization

---

## Post-Phase 3 (Future Enhancements)

### Phase 4 Ideas
- **Subscription plans** (monthly $X for unlimited basic queries)
- **Enterprise accounts** (team billing, multiple users, centralized invoice)
- **Promotional codes** (discounts, referral bonuses)
- **Cryptocurrency payments** (Bitcoin, Ethereum via BTCPay/Coinbase)
- **Mobile apps** (React Native for iOS/Android)
- **Usage analytics for users** (which tools you use most, when you're most active)
- **Budget alerts** (notify when spending exceeds X% of monthly limit)
- **Auto-topup** (automatically add $X when balance drops below $Y)

---

## Estimated Costs

### Development Time
- Frontend: 2 weeks (80 hours @ $50/hr = $4,000)
- Backend integration: 1 week (40 hours @ $50/hr = $2,000)
- Admin tools: 1 week (40 hours @ $50/hr = $2,000)
- Testing & deployment: 2 weeks (80 hours @ $50/hr = $4,000)
- **Total: $12,000 USD**

### Infrastructure
- Domain SSL certificate: $0 (Let's Encrypt)
- Additional server resources: $50/month
- Stripe fees: 2.9% + $0.30 per transaction
- Fondy fees: ~2.5% per transaction
- SMTP provider (SendGrid): $15/month (40k emails)
- Monitoring (Grafana Cloud): $0-50/month
- **Total: ~$115/month + transaction fees**

### Break-even Analysis
- If average user spends $20/month
- With 10% profit margin after costs ($2/user/month)
- Need 60 paying users to break even ($120/month revenue, $115 costs)
- At 100 paying users: $200/month profit
- At 500 paying users: $1,000/month profit

---

## Conclusion

Phase 3 transforms the billing system from **infrastructure** (Phase 1-2) into a **complete product** with user-facing UI, production payments, and operational tools.

After Phase 3, the platform is **monetization-ready** and can start generating revenue with a professional, reliable billing experience.

**Recommended Start Date:** Immediately after Phase 2 is validated in production.

**Critical Path:** Frontend (Weeks 1-2) → Production Setup (Week 3) → Everything else in parallel.

**Go-Live Criteria:** All "Success Criteria" items checked, load testing passed, 48-hour monitoring period shows no issues.
