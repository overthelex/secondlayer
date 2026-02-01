# SecondLayer MCP - Pricing Model
## California Legal Tech Startup (2026)

**Модель ценообразования**: Pay-per-use API pricing
**Конкурентный анализ**: LexisNexis ($100-300/мес), Westlaw Edge ($100-150/мес), Casetext ($89-129/мес)
**Стратегия**: Микроплатежи (micropayments) за каждый запрос - более доступно для малого бизнеса

---

## 🎯 Pricing Tiers Summary

| Tier | Tools | Price Range | Avg Price | Avg Margin | Use Case |
|------|-------|-------------|-----------|------------|----------|
| **Free** | 2 | $0.00 | $0.00 | 0% | Routing & classification |
| **Light** | 6 | $0.01 - $0.03 | $0.022 | 333% | Basic lookups |
| **Standard** | 10 | $0.04 - $0.08 | $0.061 | 199% | Search & retrieval |
| **Advanced** | 9 | $0.08 - $0.20 | $0.142 | 199% | AI analysis |
| **Premium** | 6 | $0.25 - $0.50 | $0.358 | 165% | Complex operations |
| **Flagship** | 1 | $0.75 | $0.75 | 200% | Complete legal analysis |

**Total: 34 tools**

---

## 💰 Full Pricing Table

### FREE TIER - $0.00

| Tool | Description | Cost | Price | Margin |
|------|-------------|------|-------|--------|
| classify_intent | Query classification and routing | $0.00 | **$0.00** | - |
| format_answer_pack | Result formatting (no generation) | $0.00 | **$0.00** | - |

**Use Case**: Entry points, no direct value-add

---

### LIGHT TIER - $0.01-0.03

| Tool | Description | Cost | Price | Margin |
|------|-------------|------|-------|--------|
| calculate_monetary_claims | Monetary calculations (3% interest) | $0.001 | **$0.01** | 900% |
| check_precedent_status | Precedent status validation | $0.005 | **$0.02** | 300% |
| find_relevant_law_articles | Relevant law articles lookup | $0.01 | **$0.02** | 100% |
| get_legislation_structure | Legislation structure/table of contents | $0.005 | **$0.02** | 300% |
| get_citation_graph | Citation graph construction | $0.01 | **$0.03** | 200% |
| build_procedural_checklist | Procedural checklist template | $0.01 | **$0.03** | 200% |

**Use Case**: Quick lookups, calculations, metadata
**Average**: $0.022 per request

---

### STANDARD TIER - $0.04-0.08

| Tool | Description | Cost | Price | Margin |
|------|-------------|------|-------|--------|
| search_procedural_norms | Procedural norms search (CPC/GPC) | $0.015 | **$0.04** | 167% |
| get_legislation_article | Single legislation article text | $0.01 | **$0.04** | 300% |
| get_similar_reasoning | Vector similarity search for reasoning | $0.02 | **$0.05** | 150% |
| get_legislation_section | Legislation section by reference | $0.015 | **$0.05** | 233% |
| retrieve_legal_sources | RAG retrieval without analysis | $0.025 | **$0.06** | 140% |
| search_legislation | Semantic legislation search | $0.025 | **$0.06** | 140% |
| extract_document_sections | Extract structured sections | $0.02 | **$0.07** | 250% |
| get_legislation_articles | Multiple legislation articles | $0.03 | **$0.08** | 167% |
| get_court_decision | Full court decision text + sections | $0.025 | **$0.08** | 220% |
| get_case_text | Full case text (alias) | $0.025 | **$0.08** | 220% |

**Use Case**: Document retrieval, basic search
**Average**: $0.061 per request

---

### ADVANCED TIER - $0.08-0.20

| Tool | Description | Cost | Price | Margin |
|------|-------------|------|-------|--------|
| validate_response | Anti-hallucination validation | $0.025 | **$0.08** | 220% |
| analyze_legal_patterns | Extract success arguments & risks | $0.035 | **$0.10** | 186% |
| analyze_case_pattern | Case pattern analysis | $0.04 | **$0.12** | 200% |
| parse_document | PDF/DOCX/HTML parsing with OCR | $0.04 | **$0.12** | 200% |
| search_legal_precedents | Semantic precedent search | $0.05 | **$0.15** | 200% |
| find_similar_fact_pattern_cases | Similar fact pattern search | $0.05 | **$0.15** | 200% |
| search_supreme_court_practice | Supreme Court practice search | $0.06 | **$0.18** | 200% |
| summarize_document | Document summarization | $0.06 | **$0.18** | 200% |
| compare_practice_pro_contra | Pro/contra practice comparison | $0.07 | **$0.20** | 186% |

**Use Case**: AI-powered analysis, pattern recognition
**Average**: $0.142 per request

---

### PREMIUM TIER - $0.25-0.50

| Tool | Description | Cost | Price | Margin |
|------|-------------|------|-------|--------|
| count_cases_by_party | Exact case count with pagination | $0.10 | **$0.25** | 150% |
| extract_key_clauses | Contract clause extraction + risks | $0.10 | **$0.30** | 200% |
| compare_documents | Semantic document comparison | $0.12 | **$0.35** | 192% |
| load_full_texts | Bulk full text loading | $0.15 | **$0.35** | 133% |
| calculate_procedural_deadlines | Deadline calculator with practice | $0.15 | **$0.40** | 167% |
| bulk_ingest_court_decisions | Mass ingestion + embeddings | $0.20 | **$0.50** | 150% |

**Use Case**: Complex multi-step operations, bulk processing
**Average**: $0.358 per request

---

### FLAGSHIP TIER - $0.75

| Tool | Description | Cost | Price | Margin |
|------|-------------|------|-------|--------|
| get_legal_advice | Complete legal analysis with validation | $0.25 | **$0.75** | 200% |

**Use Case**: All-in-one legal consulting, multiple API calls
**Replaces**: 5-10 manual tool calls

---

## 📊 Pricing Strategy Analysis

### Margin Strategy

| Tier | Margin % | Reasoning |
|------|----------|-----------|
| Free | 0% | Loss leader for acquisition |
| Light | 333% | High margin on simple operations |
| Standard | 199% | Healthy margin on core value |
| Advanced | 199% | Standard SaaS margin |
| Premium | 165% | Lower margin for bulk users |
| Flagship | 200% | Premium for convenience |

### Competitive Positioning

**Traditional Legal Research (per month)**:
- LexisNexis: $100-300/month (unlimited)
- Westlaw Edge: $100-150/month (unlimited)
- Casetext (CARA AI): $89-129/month (unlimited)

**SecondLayer (pay-per-use)**:
- 100 basic searches: $6.10
- 50 AI analyses: $7.10
- 20 legal advice: $15.00
- **Total: $28.20/month** (170 requests)

**Value Proposition**: 70-80% cheaper for occasional users, pay only for what you use

---

## 💡 Revenue Projections

### Scenario 1: Small Law Firm (5 lawyers)

**Monthly Usage**:
- 500 basic searches (Standard tier): $30.50
- 100 AI analyses (Advanced tier): $14.20
- 50 legal advice (Flagship): $37.50

**Total: $82.20/month**
**vs Westlaw**: $500-750/month (5 users)
**Savings**: 85-90%

### Scenario 2: Solo Practitioner

**Monthly Usage**:
- 100 searches (Standard): $6.10
- 20 analyses (Advanced): $2.84
- 10 legal advice (Flagship): $7.50

**Total: $16.44/month**
**vs Casetext**: $89/month
**Savings**: 82%

### Scenario 3: Legal Tech API Integration (ChatGPT plugin)

**Monthly Usage** (1000 users, avg 2 requests/day):
- 30,000 classify_intent (Free): $0
- 20,000 Standard tier: $1,220
- 5,000 Advanced tier: $710
- 2,000 Flagship tier: $1,500

**Total: $3,430/month**
**Per user**: $3.43/month
**Competitive Edge**: 95% cheaper than traditional subscriptions

---

## 🎯 Go-to-Market Strategy

### Phase 1: Developer/API First (Months 1-6)
- Target: ChatGPT plugins, legal tech startups
- Pricing: Pay-per-use (current model)
- Goal: 1,000 API users, $5k MRR

### Phase 2: Direct to Lawyers (Months 7-12)
- Add: Credit packages ($50 = 100 credits)
- Add: Monthly subscription tiers
- Goal: 500 lawyer users, $20k MRR

### Phase 3: Enterprise (Year 2)
- Add: Custom pricing, dedicated instances
- Add: Volume discounts (>$1k/month)
- Goal: 10 enterprise clients, $100k MRR

---

## 🚀 Competitive Advantages

1. **No subscription lock-in** - pay only for what you use
2. **Transparent pricing** - see exact cost per request
3. **Ukrainian legal focus** - specialized for Ukraine market
4. **AI-native** - built for LLM integration (ChatGPT, Claude)
5. **API-first** - easy integration for developers

---

## 📌 Recommendations

### Short Term (Q1 2026)
- ✅ Implement pricing_tiers table (DONE)
- ✅ Add cost tracking per tool (DONE)
- 🔜 Add billing integration (Stripe)
- 🔜 Create developer documentation with pricing
- 🔜 Launch free tier for developers

### Medium Term (Q2-Q3 2026)
- Add credit packages ($50, $100, $250, $500)
- Implement usage-based discounts (volume tiers)
- Create subscription plans ($29/mo, $79/mo, $199/mo)
- Add referral program (10% commission)

### Long Term (Q4 2026+)
- Enterprise custom pricing
- White-label solutions
- Dedicated instances for large clients
- API marketplace (Stripe Connect model)

---

**Date**: 2026-01-30
**Version**: 1.0
**Contact**: api@secondlayer.legal
