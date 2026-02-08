# Template Routes Integration Guide

## How to Add Template Routes to HTTP Server

### 1. Import the Route Creator

In your `http-server.ts` or main Express app setup:

```typescript
import { createTemplateRoutes } from './routes/template-routes';
import { getDatabase } from '@secondlayer/shared';
```

### 2. Register Routes

Add this where you register other routes:

```typescript
const db = getDatabase();
const templateRoutes = createTemplateRoutes(db);

// Mount at /api/templates
app.use('/api/templates', templateRoutes);
```

### 3. Ensure Authentication Middleware

The routes require Express request/response middleware. Make sure your Express app has:

```typescript
import { authMiddleware } from './middleware/auth';

app.use(express.json());
app.use(authMiddleware); // Sets up req.user if authenticated
```

### 4. Register TemplateClassifier Service

In your service factory (e.g., `factories/core-services.ts`):

```typescript
import { createTemplateClassifier } from '../services/template-system';
import { getRedisClient } from '@secondlayer/shared';

export async function createBackendCoreServices() {
  // ... existing services

  const redisClient = getRedisClient();
  const templateClassifier = createTemplateClassifier(redisClient);

  return {
    // ... existing exports
    templateClassifier,
  };
}
```

## Complete Example

```typescript
// http-server.ts
import express from 'express';
import { getDatabase } from '@secondlayer/shared';
import { createTemplateRoutes } from './routes/template-routes';

const app = express();

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Authentication middleware (your implementation)
app.use((req, res, next) => {
  // Set req.user from JWT token or API key
  // This is expected by template routes
  next();
});

// Register template routes
const db = getDatabase();
const templateRoutes = createTemplateRoutes(db);
app.use('/api/templates', templateRoutes);

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok' });
});

// Start server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
```

## API Endpoints Summary

### Classification (2 endpoints)

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| POST | `/classify-question` | Required | Classify a question |
| GET | `/classify-question/stats` | None | Get classification stats |

### Matching (2 endpoints)

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| GET | `/match` | Required | Match templates for a question |
| POST | `/match/batch` | Required | Batch match multiple questions |

### Generation & Approval (3 endpoints)

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| POST | `/generate` | Required | Generate new template |
| GET | `/generation/:id/status` | Required | Check generation status |
| PUT | `/generation/:id/approve` | Admin | Approve template (admin only) |
| PUT | `/generation/:id/reject` | Admin | Reject template (admin only) |

### Management (4 endpoints)

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| GET | `/list` | None | List all templates |
| GET | `/:id` | None | Get template details |
| PUT | `/:id` | Admin | Update template |
| DELETE | `/:id` | Admin | Deprecate template |

### Recommendations (2 endpoints)

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| GET | `/recommendations/for-me` | Required | Personalized recommendations |
| GET | `/trending` | None | Trending templates |

### Feedback (2 endpoints)

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| POST | `/:id/feedback` | Required | Submit feedback |
| POST | `/:id/rate` | Required | Submit rating (1-5) |

### Analytics (3 endpoints)

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| GET | `/:id/metrics` | None | Get template metrics |
| GET | `/analytics/dashboard` | None | Dashboard data |
| POST | `/metrics/aggregate` | Admin | Trigger aggregation |

## Authentication Requirements

### Public Endpoints (no auth required)
- `GET /list` — List templates
- `GET /:id` — Get template details
- `GET /trending` — Trending templates
- `GET /:id/metrics` — Template metrics
- `GET /analytics/dashboard` — Analytics dashboard
- `GET /classify-question/stats` — Classification stats

### User Endpoints (authentication required)
- `POST /classify-question` — Classify question
- `GET /match` — Match templates
- `POST /match/batch` — Batch matching
- `POST /generate` — Generate template
- `GET /generation/:id/status` — Check generation
- `GET /recommendations/for-me` — Personal recommendations
- `POST /:id/feedback` — Submit feedback
- `POST /:id/rate` — Submit rating

### Admin Endpoints (admin authentication required)
- `PUT /generation/:id/approve` — Approve template
- `PUT /generation/:id/reject` — Reject template
- `PUT /:id` — Update template
- `DELETE /:id` — Deprecate template
- `POST /metrics/aggregate` — Trigger aggregation

## Error Handling

All endpoints return standard error responses:

```json
{
  "error": "Error message describing what went wrong"
}
```

HTTP Status Codes:
- `200` — Success (GET, POST successful)
- `201` — Created (POST resource created)
- `400` — Bad Request (validation failed)
- `401` — Unauthorized (authentication required)
- `403` — Forbidden (insufficient permissions)
- `404` — Not Found (resource doesn't exist)
- `500` — Internal Server Error (server error)

## Example Requests

### Classify Question

```bash
curl -X POST http://localhost:3000/api/templates/classify-question \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <token>" \
  -d '{
    "question": "Як розірвати трудовий договір?"
  }'
```

Response:
```json
{
  "classification": {
    "intent": "contract termination",
    "confidence": 0.95,
    "category": "labor_law",
    "entities": {
      "dates": [],
      "amounts": [],
      "emails": []
    },
    "keywords": ["contract", "termination", "labor"],
    "reasoning": "Question is about employment contract termination",
    "alternatives": [
      {
        "intent": "resignation",
        "category": "labor_law",
        "confidence": 0.75,
        "reasoning": "Could also be about employee resignation"
      }
    ],
    "executionTimeMs": 450,
    "costUsd": 0.002
  }
}
```

### Match Templates

```bash
curl -X GET "http://localhost:3000/api/templates/match?intent=contract+termination&category=labor_law" \
  -H "Authorization: Bearer <token>"
```

Response:
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

### Submit Feedback

```bash
curl -X POST http://localhost:3000/api/templates/uuid-123/feedback \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <token>" \
  -d '{
    "rating": 5,
    "wasHelpful": true,
    "improvementSuggestion": "Could mention probation period rules"
  }'
```

Response:
```json
{
  "feedbackId": "uuid-456",
  "status": "submitted"
}
```

### Get Templates

```bash
curl "http://localhost:3000/api/templates/list?category=labor_law&status=active&limit=10"
```

Response:
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

## Dependencies

The route handler requires:

```typescript
// From @secondlayer/shared
import { AuthenticatedRequest, BaseDatabase, logger } from '@secondlayer/shared';

// From template services
import { getTemplateClassifier } from '../services/template-system';

// Standard Express
import { Router, Request, Response, NextFunction } from 'express';
import * as crypto from 'crypto';
```

## Testing

You can test endpoints with curl, Postman, or any HTTP client.

Example test with Postman:
1. Create a new request
2. Set method to `POST`
3. URL: `http://localhost:3000/api/templates/classify-question`
4. Headers:
   - `Content-Type: application/json`
   - `Authorization: Bearer <your-token>`
5. Body (raw JSON):
   ```json
   {
     "question": "Як розірвати трудовий договір?"
   }
   ```
6. Click "Send"

## Next Steps

1. ✅ Create migration 027 — DONE
2. ✅ Create TemplateClassifier service — DONE
3. ✅ Create template-routes.ts — DONE
4. ⏳ Register routes in http-server.ts (see integration example above)
5. ⏳ Implement TemplateMatcher service (semantic search)
6. ⏳ Implement TemplateGenerator service
7. ⏳ Implement TemplateStorage service
8. ⏳ Implement TemplateRecommender service
9. ⏳ Create admin dashboard components
10. ⏳ Integration testing & deployment

---

**Last Updated**: 2026-02-08
**Author**: Claude Code
**Status**: Phase 1 (Foundation) — Routes created, ready for integration
