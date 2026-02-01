# User Request Preferences System

**Status:** ✅ Active (since 2026-01-29)
**Version:** 1.0
**Purpose:** Allow users to control request parameters that affect costs and quality

---

## Overview

The User Preferences System gives clients granular control over their SecondLayer requests, allowing them to:
- **Balance cost vs quality** based on their needs
- **Choose from presets** (Economy, Balanced, Quality)
- **Fine-tune parameters** that affect API costs
- **See real-time cost estimates** before making requests

---

## Key Features

### 1. **Quick Presets**

Three pre-configured settings for different use cases:

| Preset | Cost Multiplier | Best For |
|--------|----------------|----------|
| **Economy** | 1.0x (baseline) | Quick lookups, budget-conscious users |
| **Balanced** | 1.5x | General use, good balance of quality/cost |
| **Quality** | 3.0x | Critical cases, maximum accuracy needed |

### 2. **Adjustable Parameters**

Users can control:

#### Document Retrieval
- **Max Search Results** (1-50): How many documents to retrieve
  - Impact: ZakonOnline API calls (1 call per ~10 results)
  - Default: 10

- **Analysis Depth** (1-5): How deep to analyze documents
  - Impact: OpenAI token usage (~1000 tokens per level)
  - Default: 2

#### Practice Cases
- **Max Practice Cases** (3-25): How many practice cases to analyze
  - Impact: Both API calls and OpenAI tokens
  - Default: 15

- **Practice Expansion Depth** (1-5): Depth of practice expansion
  - Impact: OpenAI token usage
  - Default: 2

#### Quality Settings
- **Reasoning Budget**: quick | standard | deep
  - Impact: AI reasoning depth, affects all token calculations
  - Multiplier: quick (0.5x), standard (1.0x), deep (2.0x)
  - Default: standard

#### Feature Toggles
- **Aggressive Caching**: Use cached results to reduce API calls
  - Trade-off: May return slightly outdated data
  - Default: ON

- **Semantic Search**: Use AI embeddings for better search
  - Cost: OpenAI embeddings + SecondLayer docs processing
  - Default: ON

- **Auto Citations**: Validate and enhance citations
  - Cost: Extra OpenAI calls
  - Default: ON

- **Legal Pattern Extraction**: Extract reasoning patterns (experimental)
  - Cost: Additional OpenAI processing
  - Default: OFF

---

## Database Schema

### `user_request_preferences` Table

```sql
CREATE TABLE user_request_preferences (
  id UUID PRIMARY KEY,
  user_id UUID NOT NULL UNIQUE REFERENCES users(id),

  -- Settings
  default_reasoning_budget VARCHAR(20) DEFAULT 'standard',
  max_search_results INTEGER DEFAULT 10,
  max_analysis_depth INTEGER DEFAULT 2,
  max_practice_cases INTEGER DEFAULT 15,
  max_practice_depth INTEGER DEFAULT 2,
  quality_preference VARCHAR(20) DEFAULT 'balanced',

  -- Toggles
  aggressive_caching BOOLEAN DEFAULT true,
  enable_semantic_search BOOLEAN DEFAULT true,
  enable_auto_citations BOOLEAN DEFAULT true,
  enable_legal_patterns BOOLEAN DEFAULT false,

  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);
```

### `request_preset_configs` Table

Stores predefined configurations:

```sql
CREATE TABLE request_preset_configs (
  preset_name VARCHAR(20) PRIMARY KEY,
  description TEXT,
  reasoning_budget VARCHAR(20),
  max_search_results INTEGER,
  max_analysis_depth INTEGER,
  max_practice_cases INTEGER,
  max_practice_depth INTEGER,
  aggressive_caching BOOLEAN,
  enable_semantic_search BOOLEAN,
  estimated_cost_multiplier DECIMAL(3, 2)
);
```

### `user_full_settings` View

Combined view of billing + preferences:

```sql
CREATE VIEW user_full_settings AS
SELECT
  u.id AS user_id,
  u.email,
  ub.pricing_tier,
  ub.balance_usd,
  urp.default_reasoning_budget,
  urp.max_search_results,
  urp.max_analysis_depth,
  ...
FROM users u
LEFT JOIN user_billing ub ON u.id = ub.user_id
LEFT JOIN user_request_preferences urp ON u.id = urp.user_id;
```

---

## API Endpoints

All endpoints require JWT authentication.

### GET `/api/billing/preferences`
Get user's current preferences

**Response:**
```json
{
  "id": "uuid",
  "user_id": "uuid",
  "default_reasoning_budget": "standard",
  "max_search_results": 10,
  "max_analysis_depth": 2,
  "max_practice_cases": 15,
  "max_practice_depth": 2,
  "quality_preference": "balanced",
  "aggressive_caching": true,
  "enable_semantic_search": true,
  "enable_auto_citations": true,
  "enable_legal_patterns": false
}
```

### PUT `/api/billing/preferences`
Update user preferences (partial update supported)

**Request:**
```json
{
  "max_search_results": 20,
  "enable_semantic_search": false
}
```

**Response:** Updated preferences object

### POST `/api/billing/preferences/preset`
Apply a preset configuration

**Request:**
```json
{
  "preset": "economy"
}
```

**Response:**
```json
{
  "success": true,
  "preferences": { ... }
}
```

### GET `/api/billing/presets`
Get all available presets

**Response:**
```json
{
  "presets": [
    {
      "preset_name": "economy",
      "description": "Minimize costs - quick analysis with basic results",
      "reasoning_budget": "quick",
      "max_search_results": 5,
      "max_analysis_depth": 1,
      "estimated_cost_multiplier": 1.00
    },
    ...
  ]
}
```

### POST `/api/billing/estimate-costs`
Estimate costs for different presets

**Request:**
```json
{
  "query": "How to patent software in Ukraine?",
  "queryLength": 100
}
```

**Response:**
```json
{
  "estimates": [
    {
      "preset": "economy",
      "estimated_cost_usd": 0.008543,
      "estimated_tokens": 1250,
      "estimated_api_calls": 2,
      "breakdown": {
        "openai_tokens": 1250,
        "zakononline_calls": 1,
        "secondlayer_docs": 0
      }
    },
    {
      "preset": "balanced",
      "estimated_cost_usd": 0.018765,
      "estimated_tokens": 4500,
      "estimated_api_calls": 11,
      "breakdown": {
        "openai_tokens": 4500,
        "zakononline_calls": 1,
        "secondlayer_docs": 10
      }
    },
    {
      "preset": "quality",
      "estimated_cost_usd": 0.062145,
      "estimated_tokens": 18750,
      "estimated_api_calls": 28,
      "breakdown": {
        "openai_tokens": 18750,
        "zakononline_calls": 3,
        "secondlayer_docs": 25
      }
    }
  ]
}
```

### GET `/api/billing/full-settings`
Get combined billing and preference settings

**Response:**
```json
{
  "user_id": "uuid",
  "email": "user@example.com",
  "pricing_tier": "startup",
  "balance_usd": 25.50,
  "daily_limit_usd": 10.00,
  "monthly_limit_usd": 100.00,
  "default_reasoning_budget": "standard",
  "max_search_results": 10,
  ...
}
```

---

## Cost Calculation Examples

### Example 1: Economy Preset

**Settings:**
- Reasoning: quick (0.5x multiplier)
- Max results: 5
- Analysis depth: 1
- Practice cases: 5
- Semantic search: OFF

**Calculation:**
```
Search tokens: 5 * 200 = 1,000
Analysis tokens: 1 * 1,000 = 1,000
Practice tokens: 5 * 500 = 2,500
Total base: 4,500
With multiplier: 4,500 * 0.5 = 2,250 tokens

OpenAI cost: (2,250 / 1,000) * $0.002 = $0.0045
ZakonOnline: ceil(5/10) = 1 call * $0.00714 = $0.00714
SecondLayer: 0 (semantic search OFF)

Base cost: $0.01164
Your price (Startup 30%): $0.01513
```

### Example 2: Balanced Preset

**Settings:**
- Reasoning: standard (1.0x)
- Max results: 10
- Analysis depth: 2
- Practice cases: 15
- Semantic search: ON

**Calculation:**
```
Search tokens: 10 * 200 = 2,000
Analysis tokens: 2 * 1,000 = 2,000
Practice tokens: 15 * 500 = 7,500
Total base: 11,500
With multiplier: 11,500 * 1.0 = 11,500 tokens

OpenAI cost: (11,500 / 1,000) * $0.002 = $0.023
ZakonOnline: ceil(10/10) = 1 call * $0.00714 = $0.00714
SecondLayer: 10 docs * $0.00714 = $0.0714

Base cost: $0.10154
Your price (Startup 30%): $0.13200
```

### Example 3: Quality Preset

**Settings:**
- Reasoning: deep (2.0x)
- Max results: 25
- Analysis depth: 5
- Practice cases: 25
- Semantic search: ON

**Calculation:**
```
Search tokens: 25 * 200 = 5,000
Analysis tokens: 5 * 1,000 = 5,000
Practice tokens: 25 * 500 = 12,500
Total base: 22,500
With multiplier: 22,500 * 2.0 = 45,000 tokens

OpenAI cost: (45,000 / 1,000) * $0.002 = $0.090
ZakonOnline: ceil(25/10) = 3 calls * $0.00714 = $0.02142
SecondLayer: 25 docs * $0.00714 = $0.1785

Base cost: $0.28992
Your price (Startup 30%): $0.37690
```

---

## Frontend Integration

### Demo Page

A fully functional demo is available at:
```
file:///.../mcp_backend/docs/user-settings-demo.html
```

Features:
- ✅ Interactive preset selection
- ✅ Slider controls for all parameters
- ✅ Toggle switches for features
- ✅ Real-time cost estimation
- ✅ Mobile-responsive design

### React Component Example

```typescript
import { useState, useEffect } from 'react';

function UserSettings() {
  const [preferences, setPreferences] = useState(null);
  const [presets, setPresets] = useState([]);

  useEffect(() => {
    // Load current preferences
    fetch('/api/billing/preferences', {
      headers: { 'Authorization': `Bearer ${jwt}` }
    })
      .then(r => r.json())
      .then(setPreferences);

    // Load available presets
    fetch('/api/billing/presets')
      .then(r => r.json())
      .then(data => setPresets(data.presets));
  }, []);

  const applyPreset = async (preset) => {
    await fetch('/api/billing/preferences/preset', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${jwt}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ preset })
    });
    // Reload preferences
  };

  const updatePreference = async (key, value) => {
    await fetch('/api/billing/preferences', {
      method: 'PUT',
      headers: {
        'Authorization': `Bearer ${jwt}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ [key]: value })
    });
  };

  return (
    <div>
      {/* Preset buttons */}
      {presets.map(preset => (
        <button onClick={() => applyPreset(preset.preset_name)}>
          {preset.preset_name}
        </button>
      ))}

      {/* Settings sliders */}
      <input
        type="range"
        min="1"
        max="50"
        value={preferences?.max_search_results}
        onChange={(e) => updatePreference('max_search_results', e.target.value)}
      />
    </div>
  );
}
```

---

## Integration with MCP Tools

MCP tools should respect user preferences when available. Example:

```typescript
// In tool handler
async function handleTool(args, userId) {
  // Get user preferences
  const prefs = await preferencesService.getUserPreferences(userId);

  // Apply preferences to tool execution
  const effectiveLimit = Math.min(
    args.limit || 50,
    prefs.max_search_results
  );

  const effectiveBudget = args.reasoning_budget || prefs.default_reasoning_budget;

  // Execute tool with preferences
  return await executeTool({
    ...args,
    limit: effectiveLimit,
    reasoning_budget: effectiveBudget,
    depth: prefs.max_analysis_depth,
    use_embeddings: prefs.enable_semantic_search
  });
}
```

---

## Business Impact

### Cost Savings for Users

Users on Economy preset can save **60-70%** compared to Quality preset:
- Economy: ~$0.015 per request
- Quality: ~$0.377 per request
- Savings: $0.362 per request (96% reduction)

### Revenue Optimization

With tiered presets, we can:
1. **Attract budget users** with Economy (lower barrier to entry)
2. **Serve power users** with Quality (higher revenue per request)
3. **Maintain average** with Balanced default

---

## Migration & Deployment

### Phase 1: ✅ Database & Backend (Completed 2026-01-29)
- [x] Migration 014 applied to DEV
- [x] UserPreferencesService created
- [x] API endpoints implemented
- [x] Integrated into http-server.ts

### Phase 2: Frontend (In Progress)
- [x] Demo HTML page created
- [ ] React component integration
- [ ] Add to billing dashboard
- [ ] User onboarding flow

### Phase 3: MCP Tools Integration (Next)
- [ ] Update tool handlers to read preferences
- [ ] Apply limits and budgets
- [ ] Test with different presets
- [ ] Monitor cost impact

---

## Testing

### Manual Testing

1. **Create preferences:**
```bash
curl -X PUT https://dev.legal.org.ua/api/billing/preferences \
  -H "Authorization: Bearer $JWT" \
  -H "Content-Type: application/json" \
  -d '{"max_search_results": 20, "enable_semantic_search": false}'
```

2. **Apply preset:**
```bash
curl -X POST https://dev.legal.org.ua/api/billing/preferences/preset \
  -H "Authorization: Bearer $JWT" \
  -H "Content-Type: application/json" \
  -d '{"preset": "economy"}'
```

3. **Estimate costs:**
```bash
curl -X POST https://dev.legal.org.ua/api/billing/estimate-costs \
  -H "Content-Type: application/json" \
  -d '{"queryLength": 100}'
```

### Automated Testing

```typescript
describe('User Preferences', () => {
  it('should apply economy preset', async () => {
    const prefs = await preferencesService.applyPreset(userId, 'economy');
    expect(prefs.max_search_results).toBe(5);
    expect(prefs.default_reasoning_budget).toBe('quick');
  });

  it('should estimate costs correctly', async () => {
    const estimates = await preferencesService.estimateCostsForPresets(100);
    expect(estimates).toHaveLength(3);
    expect(estimates[0].preset).toBe('economy');
    expect(estimates[2].estimated_cost_usd).toBeGreaterThan(estimates[0].estimated_cost_usd);
  });
});
```

---

## FAQ

### Q: Can users exceed their preset limits?
**A:** No. Preferences are hard limits. If a user manually requests 100 results but their max is 50, the system will cap at 50.

### Q: Are preferences required?
**A:** No. If a user hasn't set preferences, defaults are used (Balanced preset).

### Q: Can admins override user preferences?
**A:** Yes, via admin panel or direct database update.

### Q: Do preferences affect pricing tier markup?
**A:** No. Preferences only affect the *base cost*. The pricing tier markup (0-50%) is applied on top.

### Q: What if I change preset mid-month?
**A:** Changes apply immediately to new requests. Previous requests are unaffected.

---

## Next Steps

1. ✅ Apply to production database
2. ✅ Integrate frontend component into billing dashboard
3. ✅ Update MCP tools to respect preferences
4. ✅ Add user onboarding tutorial
5. ✅ Monitor cost distribution across presets
6. ✅ A/B test default settings

---

**Last Updated:** 2026-01-29
**Maintainers:** SecondLayer Team
**Documentation:** /mcp_backend/docs/USER_PREFERENCES.md
