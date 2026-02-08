# Template System - Endpoints Quick Reference

## All 23 Endpoints at a Glance

### Classification (2)
```
POST   /classify-question              | Classify a question → QuestionClassification
GET    /classify-question/stats        | Get stats for past N days
```

### Matching (2)
```
GET    /match                          | Match question to templates
POST   /match/batch                    | Match multiple questions (bulk)
```

### Generation & Approval (4)
```
POST   /generate                       | Generate template from unmatched question
GET    /generation/:id/status          | Check generation status & validation
PUT    /generation/:id/approve         | Approve template (admin only)
PUT    /generation/:id/reject          | Reject template (admin only)
```

### Management (4)
```
GET    /list                           | List all templates (with filtering)
GET    /:id                            | Get template details + versions + feedback
PUT    /:id                            | Update template metadata or create version
DELETE /:id                            | Soft-delete (deprecate) template
```

### Recommendations (2)
```
GET    /recommendations/for-me         | Personalized recommendations for user
GET    /trending                       | Trending templates for period
```

### Feedback & Ratings (2)
```
POST   /:id/feedback                   | Submit detailed feedback on template
POST   /:id/rate                       | Quick 1-5 star rating
```

### Analytics (3)
```
GET    /:id/metrics                    | Get metrics for template (quality, cost, ROI)
GET    /analytics/dashboard            | Dashboard overview (top, declining, stats)
POST   /metrics/aggregate              | Trigger daily metrics aggregation (admin)
```

---

## Authentication & Authorization

| Endpoint | Public | User Auth | Admin Only |
|----------|--------|-----------|------------|
| `/list` | ✅ | - | - |
| `/:id` | ✅ | - | - |
| `/:id/metrics` | ✅ | - | - |
| `/trending` | ✅ | - | - |
| `/analytics/dashboard` | ✅ | - | - |
| `/classify-question/stats` | ✅ | - | - |
| **Other endpoints** | - | ✅ | - |
| `/generation/:id/approve` | - | - | ✅ |
| `/generation/:id/reject` | - | - | ✅ |
| `PUT /:id` | - | - | ✅ |
| `DELETE /:id` | - | - | ✅ |
| `/metrics/aggregate` | - | - | ✅ |

---

## Endpoint Details

### Classification

#### POST /classify-question
Classify a user question to determine legal intent and category.

**Request:**
```json
{
  "question": "Як розірвати трудовий договір?"
}
```

**Response (200):**
```json
{
  "classification": {
    "intent": "contract termination",
    "confidence": 0.95,
    "category": "labor_law",
    "entities": { "dates": [], "amounts": [] },
    "keywords": ["contract", "termination"],
    "reasoning": "Question is about employment contract termination",
    "alternatives": [ { "intent": "resignation", "confidence": 0.75 } ],
    "executionTimeMs": 450,
    "costUsd": 0.002
  }
}
```

#### GET /classify-question/stats?days=30
Get classification statistics for the past N days.

**Response (200):**
```json
{
  "stats": {
    "total_classifications": 1500,
    "unique_intents": 45,
    "unique_categories": 12,
    "avg_confidence": 0.87,
    "max_confidence": 0.99,
    "min_confidence": 0.45
  },
  "topIntents": [
    { "classified_intent": "contract termination", "count": 156 }
  ],
  "topCategories": [
    { "category": "labor_law", "count": 342 }
  ]
}
```

---

### Matching

#### GET /match?intent=termination&category=labor_law
Match classified question against existing templates.

**Response (200):**
```json
{
  "matches": [
    {
      "templateId": "uuid-123",
      "templateName": "Labor Contract Termination",
      "matchScore": 0.92,
      "qualityScore": 95,
      "successRate": 87.5,
      "userSatisfaction": 4.6,
      "shouldGenerateNew": false
    }
  ],
  "shouldGenerate": false
}
```

#### POST /match/batch
Batch process multiple questions in one request (max 100).

**Request:**
```json
{
  "questions": [
    "Як розірвати трудовий договір?",
    "Як подати позов?"
  ]
}
```

**Response (200):**
```json
{
  "results": [
    {
      "question": "Як розірвати трудовий договір?",
      "classification": { ... },
      "matches": [ ... ]
    }
  ],
  "processedCount": 2
}
```

---

### Generation & Approval

#### POST /generate
Generate a new template when no good match exists.

**Request:**
```json
{
  "question": "Як розірвати трудовий договір?",
  "classification": { "intent": "...", "category": "labor_law" }
}
```

**Response (201):**
```json
{
  "generationId": "uuid-456",
  "status": "pending",
  "message": "Template generation started. Awaiting validation and admin review."
}
```

#### GET /generation/:id/status
Check generation status and validation results.

**Response (200):**
```json
{
  "generationId": "uuid-456",
  "status": "pending",
  "approvalStatus": "pending",
  "validationStatus": "valid",
  "template": { "name": "...", "category": "..." },
  "testResults": null,
  "adminFeedback": null,
  "rolloutPercentage": 0
}
```

#### PUT /generation/:id/approve (ADMIN)
Approve a generated template for rollout.

**Request:**
```json
{
  "approvalNotes": "Good quality, ready for production",
  "suggestedImprovements": "Consider adding probation period rules"
}
```

**Response (200):**
```json
{
  "generationId": "uuid-456",
  "status": "approved",
  "message": "Template approved and ready for rollout"
}
```

---

### Management

#### GET /list?category=labor_law&status=active&limit=10
List templates with filtering.

**Response (200):**
```json
{
  "templates": [
    {
      "id": "uuid-123",
      "name": "Labor Contract Termination",
      "category": "labor_law",
      "status": "active",
      "current_version": "1.0.0",
      "quality_score": 95,
      "success_rate": 87.5,
      "user_satisfaction": 4.6,
      "total_uses": 342,
      "created_at": "2024-02-01T10:30:00Z"
    }
  ],
  "total": 45,
  "limit": 10,
  "offset": 0,
  "hasMore": true
}
```

#### GET /:id
Get detailed template information.

**Response (200):**
```json
{
  "template": {
    "id": "uuid-123",
    "name": "Labor Contract Termination",
    "category": "labor_law",
    "prompt_template": "Mustache template with {{variables}}",
    "input_schema": { ... },
    "output_schema": { ... },
    "quality_score": 95,
    "current_version": "1.0.0"
  },
  "versions": [
    { "version_number": "1.0.0", "change_type": "major", "released_at": "..." }
  ],
  "feedback": {
    "avg_rating": 4.6,
    "total_feedback": 156,
    "helpful_count": 142
  }
}
```

#### PUT /:id (ADMIN)
Update template or create new version.

**Request:**
```json
{
  "name": "Labor Contract Termination v2",
  "status": "active"
}
```

**Response (200):**
```json
{
  "template": {
    "id": "uuid-123",
    "name": "Labor Contract Termination v2",
    "status": "active",
    "updated_at": "2024-02-08T15:30:00Z"
  }
}
```

#### DELETE /:id (ADMIN)
Deprecate template (soft delete).

**Response (200):**
```json
{
  "templateId": "uuid-123",
  "status": "deprecated"
}
```

---

### Recommendations

#### GET /recommendations/for-me?limit=10
Get personalized template recommendations.

**Response (200):**
```json
{
  "recommendations": [
    {
      "id": "rec-123",
      "template_id": "uuid-123",
      "name": "Labor Contract Termination",
      "category": "labor_law",
      "strategy": "frequency",
      "strategy_score": 85,
      "combined_score": 87.5,
      "reason": "You frequently use labor law templates",
      "confidence": 0.92
    }
  ]
}
```

#### GET /trending?days=7&limit=20
Get trending templates.

**Response (200):**
```json
{
  "period": "7 days",
  "templates": [
    {
      "id": "uuid-123",
      "name": "Labor Contract Termination",
      "category": "labor_law",
      "quality_score": 95,
      "success_rate": 87.5,
      "uses": 156,
      "avg_rating": 4.6
    }
  ]
}
```

---

### Feedback & Ratings

#### POST /:id/feedback
Submit detailed feedback on template.

**Request:**
```json
{
  "rating": 5,
  "wasHelpful": true,
  "improvementSuggestion": "Could mention probation period",
  "accuracyIssue": null,
  "missingInformation": null
}
```

**Response (201):**
```json
{
  "feedbackId": "uuid-789",
  "status": "submitted"
}
```

#### POST /:id/rate
Submit quick 1-5 star rating.

**Request:**
```json
{
  "rating": 5
}
```

**Response (200):**
```json
{
  "templateId": "uuid-123",
  "averageRating": 4.6,
  "totalRatings": 157
}
```

---

### Analytics

#### GET /:id/metrics?days=30
Get template metrics for the period.

**Response (200):**
```json
{
  "templateId": "uuid-123",
  "overall": {
    "quality_score": 95,
    "success_rate": 87.5,
    "total_uses": 342
  },
  "period": {
    "days": 30,
    "total_uses": 45,
    "avg_rating": 4.6,
    "helpful_count": 42,
    "total_cost": 0.18,
    "avg_latency_ms": 245
  }
}
```

#### GET /analytics/dashboard
Get analytics dashboard data.

**Response (200):**
```json
{
  "topTemplates": [ ... ],
  "decliningTemplates": [ ... ],
  "statistics": {
    "total_templates": 156,
    "active_templates": 142,
    "avg_quality_score": 82.3,
    "avg_success_rate": 76.5
  },
  "recentGenerations": [ ... ]
}
```

#### POST /metrics/aggregate (ADMIN)
Trigger daily metrics aggregation.

**Request:**
```json
{
  "templateId": "uuid-123",
  "date": "2024-02-08"
}
```

**Response (200):**
```json
{
  "status": "aggregated",
  "templateId": "uuid-123",
  "date": "2024-02-08"
}
```

---

## Error Responses

All errors follow this format:

```json
{
  "error": "Descriptive error message"
}
```

### Common Status Codes
- `200` — OK (GET success)
- `201` — Created (POST success)
- `400` — Bad Request (validation failed)
- `401` — Unauthorized (auth required)
- `403` — Forbidden (admin required)
- `404` — Not Found (resource missing)
- `500` — Server Error

---

## Rate Limits (TBD)

Recommended rate limits:
- Classification: 60 req/min per user
- Matching: 100 req/min per user
- All others: 30 req/min per user
- Admin: No limit

---

**Last Updated**: 2026-02-08
**Total Endpoints**: 23
**Public Endpoints**: 6
**User Endpoints**: 12
**Admin Endpoints**: 5
