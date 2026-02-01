# SecondLayer Pricing Model

**Status:** ✅ Active (since 2026-01-29)
**Version:** 1.0
**Last Updated:** 2026-01-29

---

## Executive Summary

SecondLayer operates as a SaaS startup providing AI-powered legal research tools for Ukrainian law. Our pricing model uses **cost-plus pricing** with tiered markups based on client segment.

**Key Principles:**
- **Transparent Cost Structure** - Clients know what they pay and why
- **Tiered Pricing** - Different markups for different customer segments
- **Volume Discounts** - Automatic discounts for high-spending users
- **No Hidden Fees** - All costs itemized (OpenAI, ZakonOnline, SecondLayer)

---

## Pricing Tiers

### 🆓 Free Tier
**Markup:** 0% (Cost Pass-Through)

**Target Audience:**
- Early adopters and beta testers
- Internal team usage
- Testing and development
- Non-profit organizations (by request)

**Features:**
- Full access to all tools
- Cost transparency (you pay exactly what we pay)
- Community support
- Rate limits apply

**Example:**
```
Our cost: $10.00
Markup: 0%
Your price: $10.00
```

---

### 🚀 Startup Tier (Default)
**Markup:** 30%

**Target Audience:**
- Individual lawyers and small law firms
- Freelance legal consultants
- Startups and small businesses
- Students and researchers

**Features:**
- Full access to all tools
- 30% markup on API costs
- Email support (24-48h response)
- Standard rate limits (10 requests/day, 100/month)
- Monthly usage reports

**Example:**
```
Our cost: $10.00
Markup: 30% ($3.00)
Your price: $13.00
Our profit: $3.00
```

**Real Example (Crypto requests from today):**
```
Our cost: $0.053450
Markup: 30% ($0.016035)
Your price: $0.069485
Our profit: $0.016035 (30%)
```

---

### 💼 Business Tier
**Markup:** 50%

**Target Audience:**
- Medium and large law firms (10+ lawyers)
- Corporate legal departments
- Legal tech companies
- High-volume users

**Features:**
- Full access to all tools
- 50% markup on API costs
- Priority email support (12h response)
- Higher rate limits (50 requests/day, 500/month)
- Dedicated account manager
- Custom integrations support
- Advanced analytics dashboard
- Early access to new features

**Example:**
```
Our cost: $10.00
Markup: 50% ($5.00)
Your price: $15.00
Our profit: $5.00
```

**Real Example (Crypto requests from today):**
```
Our cost: $0.053450
Markup: 50% ($0.026725)
Your price: $0.080175
Our profit: $0.026725 (50%)
```

---

### 🏢 Enterprise Tier
**Markup:** 40% (Negotiable)

**Target Audience:**
- Large enterprises and corporations
- Government agencies
- International law firms
- High-volume users (1000+ requests/month)

**Features:**
- Full access to all tools
- 40% markup (customizable based on volume)
- Priority 24/7 support
- No rate limits
- Dedicated infrastructure (optional)
- SLA guarantees (99.9% uptime)
- Custom tool development
- On-premise deployment options
- White-label solutions
- Custom billing (monthly invoices)

**Example:**
```
Our cost: $10.00
Markup: 40% ($4.00)
Your price: $14.00
Our profit: $4.00
```

**Note:** Enterprise contracts are individually negotiated. Markup can be adjusted based on:
- Committed monthly volume
- Contract length (annual vs monthly)
- Custom feature requirements
- Deployment model (cloud vs on-premise)

---

## Cost Breakdown

Every request incurs three types of costs:

### 1. OpenAI API Costs
- **GPT-4o:** ~$0.01-0.03 per request (depending on complexity)
- **GPT-4o-mini:** ~$0.001-0.005 per request
- **Embeddings (text-embedding-ada-002):** ~$0.0001 per 1k tokens

### 2. ZakonOnline API Costs
- **Fixed:** $0.00714 per API call
- **Tiered:** Volume discounts at 10k, 20k, 30k, 50k+ calls/month
- **Cached:** No cost for cached results

### 3. SecondLayer Processing Costs
- **Web scraping:** $0.00714 per document
- **Document processing:** Included in OpenAI costs
- **Caching & Storage:** Free (infrastructure costs absorbed)

---

## Example Pricing Calculations

### Simple Search Query

**Request:** "Find court cases about cryptocurrency taxation"

**Costs:**
- OpenAI (query classification): $0.000245
- ZakonOnline API (1 search): $0.00714
- SecondLayer (0 docs): $0.00000
- **Total Cost:** $0.007385

**Your Price by Tier:**
- **Free:** $0.007385 (0% markup)
- **Startup:** $0.009600 (30% markup, +$0.002215 profit)
- **Business:** $0.011078 (50% markup, +$0.003693 profit)
- **Enterprise:** $0.010339 (40% markup, +$0.002954 profit)

---

### Complex Legal Analysis

**Request:** "Provide full legal analysis on crypto income taxation with court precedents"

**Costs:**
- OpenAI (intent, analysis, embeddings): $0.020225
- ZakonOnline API (multiple searches): $0.02142 (3 calls × $0.00714)
- SecondLayer (document loading): $0.00714 (1 doc)
- **Total Cost:** $0.048785

**Your Price by Tier:**
- **Free:** $0.048785 (0% markup)
- **Startup:** $0.063421 (30% markup, +$0.014636 profit)
- **Business:** $0.073178 (50% markup, +$0.024393 profit)
- **Enterprise:** $0.068299 (40% markup, +$0.019514 profit)

---

## Volume Discounts

In addition to tier markups, we offer automatic volume discounts based on monthly spending:

| Monthly Spending | Discount | Example Savings |
|------------------|----------|-----------------|
| $0 - $249 | 0% | - |
| $250 - $499 | 5% | $12.50/month at $250/mo |
| $500 - $999 | 10% | $50/month at $500/mo |
| $1000+ | 15% | $150/month at $1000/mo |

**Note:** Volume discounts apply AFTER tier markup.

**Example (Startup tier, $500/month spending):**
```
Base cost: $500
Markup (30%): +$150
Subtotal: $650
Volume discount (10%): -$65
Final price: $585
Monthly savings: $65
```

---

## Tier Recommendations

The system automatically recommends the optimal tier based on your usage:

- **$0/month** → Free tier
- **$1-99/month** → Startup tier (30% markup)
- **$100-499/month** → Business tier (50% markup, but better features)
- **$500+/month** → Enterprise tier (40% markup, volume discounts, SLAs)

**Switch at any time** - no contracts, no penalties.

---

## Revenue Projections

### Break-Even Analysis

At **Startup tier (30% markup)**:
- 10 paying users at $20/month → $260 revenue, $60 profit
- 50 paying users at $20/month → $1,300 revenue, $300 profit
- 100 paying users at $20/month → $2,600 revenue, $600 profit

At **Business tier (50% markup)**:
- 10 paying users at $50/month → $750 revenue, $250 profit
- 50 paying users at $50/month → $3,750 revenue, $1,250 profit
- 100 paying users at $50/month → $7,500 revenue, $2,500 profit

### Conservative Monthly Revenue (Year 1)

**Assumptions:**
- 70% Startup tier ($20/month avg)
- 25% Business tier ($50/month avg)
- 5% Enterprise tier ($200/month avg)

| Users | Revenue | Profit | Margin |
|-------|---------|--------|--------|
| 50 | $1,550 | $465 | 30% |
| 100 | $3,100 | $930 | 30% |
| 250 | $7,750 | $2,325 | 30% |
| 500 | $15,500 | $4,650 | 30% |
| 1000 | $31,000 | $9,300 | 30% |

---

## Competitive Positioning

### vs Legal Research Platforms (Ukraine)

| Platform | Model | Price | Notes |
|----------|-------|-------|-------|
| **ZakonOnline** | Subscription | $300/month | Database only, no AI |
| **YouControl** | Subscription | $150/month | Company data, limited legal |
| **Liga:Zakon** | Subscription | $500/month | Full legal DB, no AI |
| **SecondLayer Startup** | Pay-as-you-go | ~$20/month | AI-powered, flexible |
| **SecondLayer Business** | Pay-as-you-go | ~$50/month | AI + support |

**Our Advantage:**
- ✅ **Pay-as-you-go** (no large upfront costs)
- ✅ **AI-powered analysis** (not just search)
- ✅ **Transparent pricing** (know what you pay)
- ✅ **Flexible tiers** (grow with your needs)

---

## Pricing FAQ

### Q: Can I change tiers?
**A:** Yes, anytime. Change takes effect immediately.

### Q: What happens if I run out of balance?
**A:** Requests are blocked until you top up. No overdraft fees.

### Q: Are there any hidden fees?
**A:** No. All costs are itemized in your transaction history.

### Q: Do you offer discounts for non-profits?
**A:** Yes, contact us for Free tier access.

### Q: Can I negotiate pricing?
**A:** Enterprise tier pricing is always negotiable. Startup/Business tiers are fixed.

### Q: What payment methods do you accept?
**A:** Stripe (USD, card payments) and Fondy (UAH, Ukrainian cards).

### Q: Are there refunds?
**A:** Yes, unused balance can be refunded within 7 days of top-up.

---

## Technical Implementation

### Database Schema
```sql
-- User billing with pricing tier
ALTER TABLE user_billing
ADD COLUMN pricing_tier VARCHAR(20) DEFAULT 'startup';

-- Cost tracking with markup transparency
ALTER TABLE cost_tracking
ADD COLUMN base_cost_usd DECIMAL(10, 6),
ADD COLUMN markup_percentage DECIMAL(5, 2),
ADD COLUMN markup_amount_usd DECIMAL(10, 6),
ADD COLUMN client_tier VARCHAR(20);
```

### API Integration
```typescript
// Automatic pricing calculation
const billing = await billingService.getOrCreateUserBilling(userId);
const tier = billing.pricing_tier; // 'free', 'startup', 'business', 'enterprise'

// Calculate price with markup
const priceCalc = pricingService.calculatePrice(baseCost, tier);
// {
//   cost_usd: 10.00,
//   markup_percentage: 30,
//   markup_amount_usd: 3.00,
//   price_usd: 13.00,
//   tier: 'startup'
// }

// Charge user
await billingService.chargeUser({
  userId,
  requestId,
  amountUsd: priceCalc.price_usd, // Charged amount includes markup
  description: toolName
});
```

---

## Migration Plan

### Phase 1: ✅ Implementation (2026-01-29)
- [x] Create `PricingService` with tier logic
- [x] Add `pricing_tier` to `user_billing` table
- [x] Update `BillingService.chargeUser()` to apply markup
- [x] Add pricing metadata to `cost_tracking` table

### Phase 2: 🔄 Deployment (Next)
- [ ] Run migration 013_add_pricing_tiers.sql
- [ ] Update all existing users to 'startup' tier
- [ ] Test with sample requests
- [ ] Monitor profit margins

### Phase 3: 📈 Rollout (Week 2)
- [ ] Update frontend billing dashboard with tier selector
- [ ] Add pricing comparison page
- [ ] Enable tier changes for users
- [ ] Email existing users about new pricing

### Phase 4: 🎯 Optimization (Month 2)
- [ ] A/B test different markup percentages
- [ ] Analyze tier conversion rates
- [ ] Optimize volume discount thresholds
- [ ] Add upsell prompts in dashboard

---

## Success Metrics

**KPIs to Track:**
- Average revenue per user (ARPU)
- Profit margin by tier
- Tier conversion rates (free → startup → business)
- Monthly recurring revenue (MRR)
- Customer lifetime value (LTV)
- Churn rate by tier

**Target for Year 1:**
- 500 paying users
- $15,000 MRR
- 30% profit margin
- <10% monthly churn

---

## Contact

Questions about pricing? Contact:
- **Email:** billing@legal.org.ua
- **Telegram:** @secondlayer_support
- **Website:** https://legal.org.ua/pricing

---

**Last Updated:** 2026-01-29
**Next Review:** 2026-03-01 (2 months)
