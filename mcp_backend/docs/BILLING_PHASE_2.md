# Phase 2 Billing Implementation Plan
## Stripe + Fondy Payment Integration & Frontend Dashboard

**Target:** https://billing.legal.org.ua
**Backend API:** https://mcp.legal.org.ua
**Timeline:** 3-4 weeks

---

## Overview

Phase 2 adds payment processing capabilities to the existing Phase 1 billing infrastructure. Users will be able to:
1. **Top up balance** via Stripe (international cards) or Fondy (Ukrainian cards)
2. **View transaction history** with detailed cost breakdowns
3. **Monitor spending** against daily/monthly limits
4. **Receive email alerts** for low balance and payment confirmations

**Pre-flight balance checks** will prevent tool execution when users have insufficient funds.

---

## Critical Files to Modify/Create

### Backend (mcp_backend)

**New Services:**
1. `/src/services/stripe-service.ts` - Stripe payment integration
2. `/src/services/fondy-service.ts` - Fondy payment integration
3. `/src/services/email-service.ts` - Email notifications

**New Middleware:**
4. `/src/middleware/balance-check.ts` - Pre-flight balance validation

**New Routes:**
5. `/src/routes/payment-routes.ts` - Payment & webhook endpoints

**Modifications:**
6. `/src/http-server.ts` - Integrate services, add routes, add middleware
7. `/src/migrations/009_payment_integration.sql` - Database schema updates

**Configuration:**
8. `/mcp_backend/.env` - Add payment provider credentials
9. `/mcp_backend/package.json` - Add dependencies

### Frontend (NEW)

**New Directory:** `/billing-frontend/`

**Core Files:**
10. `package.json`, `tsconfig.json`, `vite.config.ts`
11. `src/main.tsx`, `src/App.tsx` - React app setup
12. `src/api/client.ts`, `src/api/billing.ts` - API integration
13. `src/pages/Dashboard.tsx` - Main billing dashboard
14. `src/pages/TopUp.tsx` - Payment page (Stripe/Fondy)
15. `src/pages/Transactions.tsx` - Transaction history
16. `src/components/BalanceCard.tsx`, `LimitsCard.tsx`, etc.
17. `Dockerfile`, `nginx.conf` - Production deployment

### Deployment

18. `/deployment/docker-compose.billing.yml` - Frontend container
19. `/deployment/nginx-proxy.conf` - Add billing subdomain routing
20. Gate server: `/etc/nginx/sites-available/billing.legal.org.ua` - SSL config

---

## Part 1: Backend Implementation

### 1.1 Dependencies

Add to `mcp_backend/package.json`:
```json
{
  "dependencies": {
    "stripe": "^14.12.0",
    "nodemailer": "^6.9.8"
  },
  "devDependencies": {
    "@types/nodemailer": "^6.4.14"
  }
}
```

### 1.2 Stripe Service

**File:** `src/services/stripe-service.ts`

**Key Methods:**
- `createPaymentIntent(userId, amountUsd, email)` - Create Stripe PaymentIntent
- `handleWebhook(payload, signature)` - Process webhook events
- `handlePaymentSuccess(paymentIntent)` - Call `billingService.topUpBalance()`
- `handlePaymentFailure(paymentIntent)` - Send failure email
- `getPaymentStatus(paymentIntentId)` - Check payment status

**Integration:**
- Uses Stripe SDK v14
- Verifies webhook signatures with `STRIPE_WEBHOOK_SECRET`
- Converts amount to cents (multiply by 100)
- Stores payment ID in `billing_transactions.payment_id`
- Sends email on success/failure

### 1.3 Fondy Service

**File:** `src/services/fondy-service.ts`

**Key Methods:**
- `createPayment(userId, amountUah, email, orderId, description)` - Generate payment URL
- `handleCallback(callbackData)` - Process Fondy callback
- `generateSignature(data)` - Create MD5 signature
- `verifySignature(data, receivedSignature)` - Validate callback
- `getPaymentStatus(orderId)` - Check payment status

**Integration:**
- Uses Fondy REST API (no official SDK)
- Signature: MD5 hash of `secret_key|sorted_values`
- Amount in kopiykas (multiply by 100)
- Redirects user to Fondy checkout URL
- Server callback to `/webhooks/fondy`

### 1.4 Email Service

**File:** `src/services/email-service.ts`

**Key Methods:**
- `sendLowBalanceAlert(email, name, balance, currency)`
- `sendPaymentSuccess(email, name, amount, currency, newBalance, paymentId)`
- `sendPaymentFailure(email, name, amount, currency, reason)`

**Configuration:**
- Uses nodemailer with SMTP
- HTML email templates (inline CSS)
- Links to `FRONTEND_URL` for top-up/dashboard
- Development mode: JSON transport (log only)

### 1.5 Pre-flight Balance Check Middleware

**File:** `src/middleware/balance-check.ts`

**Flow:**
1. Skip if API key auth (not subject to billing)
2. Extract userId from JWT
3. Get billing account via `billingService.getOrCreateUserBilling()`
4. Skip if `billing_enabled = false`
5. Estimate cost via `costTracker.estimateCost()`
6. Check balance via `billingService.checkBalance()`
7. Check limits via `billingService.checkLimits()`
8. Return 402 Payment Required if insufficient
9. Return 429 Too Many Requests if limits exceeded
10. Otherwise, continue to tool execution

**Error Response:**
```json
{
  "error": "Insufficient balance",
  "message": "Required: $0.50, Available: $0.25",
  "code": "INSUFFICIENT_BALANCE",
  "balance": {
    "current_usd": 0.25,
    "required_usd": 0.50,
    "shortfall_usd": 0.25
  },
  "topup_url": "https://billing.legal.org.ua/topup"
}
```

### 1.6 Payment Routes

**File:** `src/routes/payment-routes.ts`

**Payment Endpoints (require JWT):**
- `POST /api/billing/payment/stripe/create` - Create Stripe PaymentIntent
  - Input: `{ amount_usd: number }`
  - Output: `{ clientSecret, paymentIntentId }`
- `POST /api/billing/payment/fondy/create` - Create Fondy payment
  - Input: `{ amount_uah: number }`
  - Output: `{ paymentUrl, orderId }`
- `GET /api/billing/payment/:provider/:paymentId/status` - Check status
  - Output: `{ status, amount, currency }`

**Webhook Endpoints (no auth, signature verification):**
- `POST /webhooks/stripe` - Stripe webhook (raw body required)
- `POST /webhooks/fondy` - Fondy callback (JSON body)

### 1.7 Integration in http-server.ts

**Changes at line ~100 (constructor):**
```typescript
this.emailService = new EmailService();
this.stripeService = new StripeService(this.billingService, this.emailService);
this.fondyService = new FondyService(this.billingService, this.emailService);
const balanceCheckMiddleware = createBalanceCheckMiddleware(
  this.billingService,
  this.costTracker
);
```

**Changes in setupRoutes():**
```typescript
// Mount webhooks EARLY (before JSON middleware for Stripe raw body)
this.app.use('/webhooks', createWebhookRouter(this.stripeService, this.fondyService));

// Mount payment routes
this.app.use('/api/billing/payment', createPaymentRouter(this.stripeService, this.fondyService));
```

**Changes at line 468 (tool endpoint):**
```typescript
this.app.post('/api/tools/:toolName',
  dualAuth as any,
  balanceCheckMiddleware as any,  // <-- ADD THIS
  (async (req: DualAuthRequest, res: Response) => {
    // existing logic...
  }) as any
);
```

### 1.8 Database Migration

**File:** `src/migrations/009_payment_integration.sql`

**Changes:**
```sql
-- Add payment tracking fields to user_billing
ALTER TABLE user_billing
ADD COLUMN last_alert_sent_at TIMESTAMPTZ,
ADD COLUMN stripe_customer_id VARCHAR(255),
ADD COLUMN fondy_customer_id VARCHAR(255);

-- Indexes for payment lookups
CREATE INDEX idx_billing_transactions_payment_id ON billing_transactions(payment_id);
CREATE INDEX idx_billing_transactions_payment_provider ON billing_transactions(payment_provider);

-- Payment intents table (for idempotency)
CREATE TABLE payment_intents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider VARCHAR(50) NOT NULL,
  external_id VARCHAR(255) NOT NULL,
  amount_usd DECIMAL(10,2) NOT NULL,
  amount_uah DECIMAL(10,2),
  status VARCHAR(50) NOT NULL,
  metadata JSONB,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(provider, external_id)
);
```

### 1.9 Environment Variables

Add to `mcp_backend/.env`:
```bash
# Stripe
STRIPE_SECRET_KEY=sk_test_...  # Production: sk_live_...
STRIPE_PUBLISHABLE_KEY=pk_test_...  # For frontend
STRIPE_WEBHOOK_SECRET=whsec_...  # From Stripe Dashboard

# Fondy
FONDY_MERCHANT_ID=1234567
FONDY_SECRET_KEY=test_secret_key
FONDY_API_URL=https://pay.fondy.eu/api

# Email
EMAIL_FROM=noreply@legal.org.ua
EMAIL_FROM_NAME=SecondLayer Legal Platform
SMTP_HOST=smtp.gmail.com
SMTP_PORT=587
SMTP_SECURE=false
SMTP_USER=your-email@gmail.com
SMTP_PASS=your-app-password

# Frontend/Backend URLs
FRONTEND_URL=https://billing.legal.org.ua
BACKEND_URL=https://mcp.legal.org.ua
```

---

## Part 2: Frontend Implementation

### 2.1 Project Structure

**Create directory:** `/home/vovkes/SecondLayer/billing-frontend/`

```
billing-frontend/
├── package.json
├── tsconfig.json
├── vite.config.ts
├── tailwind.config.js
├── postcss.config.js
├── index.html
├── .env.production
├── Dockerfile
├── nginx.conf
└── src/
    ├── main.tsx
    ├── App.tsx
    ├── api/
    │   ├── client.ts          # Axios instance with auth
    │   └── billing.ts         # API functions
    ├── components/
    │   ├── Layout.tsx         # Header/sidebar
    │   ├── BalanceCard.tsx    # Current balance display
    │   ├── LimitsCard.tsx     # Daily/monthly limits
    │   └── TransactionTable.tsx
    ├── pages/
    │   ├── Login.tsx          # Redirect to OAuth
    │   ├── Dashboard.tsx      # Main page
    │   ├── TopUp.tsx          # Payment page
    │   └── Transactions.tsx   # History table
    └── types/
        └── billing.ts         # TypeScript interfaces
```

### 2.2 Tech Stack

**Framework:** React 18 + TypeScript
**Build Tool:** Vite 5
**Styling:** Tailwind CSS 3
**State Management:** React Query 3
**HTTP Client:** Axios
**Payment:** @stripe/stripe-js, @stripe/react-stripe-js
**Icons:** lucide-react
**Date Formatting:** date-fns

### 2.3 Key Files

#### package.json
```json
{
  "name": "billing-frontend",
  "version": "1.0.0",
  "scripts": {
    "dev": "vite",
    "build": "tsc && vite build",
    "preview": "vite preview"
  },
  "dependencies": {
    "react": "^18.2.0",
    "react-dom": "^18.2.0",
    "react-router-dom": "^6.21.1",
    "react-query": "^3.39.3",
    "axios": "^1.6.5",
    "@stripe/stripe-js": "^2.4.0",
    "@stripe/react-stripe-js": "^2.4.0",
    "date-fns": "^3.0.6",
    "lucide-react": "^0.309.0"
  },
  "devDependencies": {
    "@types/react": "^18.2.47",
    "@types/react-dom": "^18.2.18",
    "@vitejs/plugin-react": "^4.2.1",
    "typescript": "^5.3.3",
    "vite": "^5.0.11",
    "tailwindcss": "^3.4.1",
    "autoprefixer": "^10.4.16",
    "postcss": "^8.4.33"
  }
}
```

#### src/api/client.ts
```typescript
import axios from 'axios';

const API_BASE_URL = import.meta.env.VITE_API_URL || 'https://mcp.legal.org.ua';

export const apiClient = axios.create({
  baseURL: API_BASE_URL,
  headers: {
    'Content-Type': 'application/json',
  },
});

// Attach JWT token from localStorage
apiClient.interceptors.request.use((config) => {
  const token = localStorage.getItem('jwt_token');
  if (token) {
    config.headers.Authorization = `Bearer ${token}`;
  }
  return config;
});

// Redirect to login on 401
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

#### src/api/billing.ts
```typescript
import { apiClient } from './client';

export const billingAPI = {
  getBalance: () => apiClient.get('/api/billing/balance'),
  getHistory: (limit = 50, offset = 0) =>
    apiClient.get(`/api/billing/history?limit=${limit}&offset=${offset}`),
  createStripePayment: (amountUsd: number) =>
    apiClient.post('/api/billing/payment/stripe/create', { amount_usd: amountUsd }),
  createFondyPayment: (amountUah: number) =>
    apiClient.post('/api/billing/payment/fondy/create', { amount_uah: amountUah }),
  getPaymentStatus: (provider: string, paymentId: string) =>
    apiClient.get(`/api/billing/payment/${provider}/${paymentId}/status`),
};
```

#### src/pages/Dashboard.tsx
Main page showing:
- BalanceCard (current balance USD/UAH)
- LimitsCard (daily/monthly progress bars)
- Quick top-up button
- Recent transactions (last 5)

#### src/pages/TopUp.tsx
Payment page with:
- Amount input (USD or UAH)
- Provider selector (Stripe/Fondy radio buttons)
- **Stripe:** Embed Stripe Elements (card form)
- **Fondy:** Redirect to Fondy checkout URL
- Loading states & success/error messages

#### Dockerfile
```dockerfile
FROM node:20-alpine AS builder
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM nginx:alpine
COPY --from=builder /app/dist /usr/share/nginx/html
COPY nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 80
```

#### nginx.conf (frontend)
```nginx
server {
    listen 80;
    server_name _;
    root /usr/share/nginx/html;
    index index.html;

    # SPA routing
    location / {
        try_files $uri $uri/ /index.html;
    }

    # Cache static assets
    location ~* \.(js|css|png|jpg|jpeg|gif|ico|svg)$ {
        expires 1y;
        add_header Cache-Control "public, immutable";
    }
}
```

---

## Part 3: Deployment

### 3.1 Docker Compose

**Create:** `/home/vovkes/SecondLayer/deployment/docker-compose.billing.yml`

```yaml
version: '3.8'

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
    networks:
      - secondlayer-network

networks:
  secondlayer-network:
    external: true
```

### 3.2 Nginx Proxy Configuration

Add to `/home/vovkes/SecondLayer/deployment/nginx-proxy.conf`:

```nginx
# Billing frontend upstream
upstream billing_frontend {
    server host.docker.internal:8092;
    keepalive 32;
}

# Billing subdomain
server {
    listen 80;
    server_name billing.legal.org.ua;

    # Proxy to billing frontend
    location / {
        proxy_pass http://billing_frontend;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header Connection "";
    }
}
```

### 3.3 Gate Server Configuration

**Create:** `/etc/nginx/sites-available/billing.legal.org.ua` (on gate server)

```nginx
# HTTP - redirect to HTTPS
server {
    listen 80;
    listen [::]:80;
    server_name billing.legal.org.ua;

    location /.well-known/acme-challenge/ {
        root /var/www/html;
    }

    location / {
        return 301 https://$server_name$request_uri;
    }
}

# HTTPS
server {
    listen 443 ssl http2;
    listen [::]:443 ssl http2;
    server_name billing.legal.org.ua;

    # SSL (shared with legal.org.ua)
    ssl_certificate /etc/letsencrypt/live/legal.org.ua/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/legal.org.ua/privkey.pem;

    # Proxy to nginx-proxy container
    location / {
        proxy_pass http://localhost:8085;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header Connection "";
    }
}
```

**Enable:**
```bash
sudo ln -s /etc/nginx/sites-available/billing.legal.org.ua /etc/nginx/sites-enabled/
sudo nginx -t
sudo systemctl reload nginx
```

### 3.4 SSL Certificate

**Add billing subdomain to existing certificate:**
```bash
sudo certbot certonly --nginx \
  -d legal.org.ua \
  -d billing.legal.org.ua \
  --cert-name legal.org.ua
```

---

## Part 4: Implementation Order

### Phase 1: Backend Core (Week 1)
1. ✅ Add dependencies to package.json
2. ✅ Create StripeService with webhook handling
3. ✅ Create FondyService with callback handling
4. ✅ Create EmailService with templates
5. ✅ Create payment routes (payment + webhook endpoints)
6. ✅ Run migration 009
7. ✅ Update .env with credentials

### Phase 2: Backend Integration (Week 1-2)
8. ✅ Integrate services in http-server.ts
9. ✅ Create balance check middleware
10. ✅ Add middleware to tool execution pipeline
11. ✅ Test with Stripe test mode
12. ✅ Test with Fondy test credentials

### Phase 3: Frontend (Week 2-3)
13. ✅ Initialize React project with Vite
14. ✅ Setup routing and auth flow
15. ✅ Create Dashboard page
16. ✅ Create TopUp page with Stripe Elements
17. ✅ Create Transactions page
18. ✅ Test API integration
19. ✅ Build Docker image

### Phase 4: Deployment (Week 3-4)
20. ✅ Deploy backend changes to production
21. ✅ Setup billing.legal.org.ua on gate server
22. ✅ Deploy frontend container
23. ✅ Configure SSL certificate
24. ✅ Test end-to-end payment flow
25. ✅ Monitor logs and webhooks

### Phase 5: Testing & Monitoring (Week 4)
26. ✅ Test Stripe payment flow (test card: 4242 4242 4242 4242)
27. ✅ Test Fondy payment flow
28. ✅ Test email notifications
29. ✅ Test pre-flight balance checks
30. ✅ Verify transaction recording
31. ✅ Load testing with concurrent requests

---

## Testing Strategy

### Unit Tests
- StripeService: Mock Stripe SDK, test webhook signature verification
- FondyService: Mock axios, test signature generation/validation
- EmailService: Mock nodemailer, verify email content
- Balance middleware: Mock billing service, test error responses

### Integration Tests
- Create payment → webhook → balance update flow
- Pre-flight check → insufficient balance → 402 response
- Daily limit exceeded → 429 response

### E2E Tests
1. User logs in via Google OAuth
2. Dashboard shows $0 balance
3. User clicks "Top Up"
4. Selects Stripe, enters $10
5. Completes payment with test card
6. Webhook processes payment
7. Balance updates to $10
8. User receives confirmation email
9. User makes tool call, balance decreases
10. Transaction appears in history

### Webhook Testing
- Use Stripe CLI: `stripe listen --forward-to localhost:3000/webhooks/stripe`
- Use Fondy test environment
- Verify idempotency (duplicate webhooks)
- Test signature failures

---

## Security Considerations

### Payment Security
- ✅ Never store card numbers (use Stripe Elements)
- ✅ Webhook signature verification (Stripe & Fondy)
- ✅ HTTPS only for all endpoints
- ✅ Idempotency keys for duplicate webhooks
- ✅ Rate limiting on payment endpoints

### Authentication
- ✅ JWT required for all billing endpoints
- ✅ Webhook endpoints have no JWT (use signatures)
- ✅ CORS configuration for billing.legal.org.ua

### Data Protection
- ✅ Balance updates use PostgreSQL transactions
- ✅ Payment metadata stored in JSONB (encrypted at rest)
- ✅ Email addresses from JWT (verified by Google OAuth)

---

## Monitoring & Alerts

### Metrics to Track
- Payment success rate (Stripe/Fondy)
- Webhook processing time
- Failed payments (declined cards)
- Balance alerts sent
- Pre-flight check rejections (insufficient balance)
- Daily/monthly revenue

### Log Queries
```bash
# Successful payments
docker logs secondlayer-app-prod 2>&1 | grep "Payment successful"

# Failed webhooks
docker logs secondlayer-app-prod 2>&1 | grep "webhook.*failed"

# Insufficient balance rejections
docker logs secondlayer-app-prod 2>&1 | grep "Insufficient balance"
```

---

## Rollback Plan

If issues arise:
1. **Disable pre-flight checks:** Comment out middleware in http-server.ts
2. **Disable webhooks:** Return 200 immediately, log to investigate
3. **Frontend:** Nginx can serve static "maintenance" page
4. **Database:** Migration 009 has `down()` function for rollback

---

## Post-Deployment Checklist

- [ ] Stripe webhook endpoint verified in dashboard
- [ ] Fondy callback URL configured
- [ ] SSL certificate includes billing.legal.org.ua
- [ ] SMTP credentials tested (send test email)
- [ ] Frontend can reach backend API (CORS)
- [ ] OAuth redirect works (FRONTEND_URL correct)
- [ ] Test payment with real card (small amount)
- [ ] Verify balance updates in database
- [ ] Check transaction history shows payment
- [ ] Email confirmation received

---

## Success Criteria

Phase 2 is complete when:
- ✅ Users can top up balance via Stripe (USD)
- ✅ Users can top up balance via Fondy (UAH)
- ✅ Webhooks process payments automatically
- ✅ Balance updates are atomic and recorded
- ✅ Pre-flight checks block insufficient balance
- ✅ Email notifications sent on success/failure
- ✅ Frontend dashboard shows real-time balance
- ✅ Transaction history displays all payments
- ✅ All endpoints protected by JWT
- ✅ Production deployment successful

---

**Estimated Completion:** 3-4 weeks
**Risk Level:** Medium (payment integration always carries risk)
**Dependencies:** Phase 1 billing (✅ complete)
