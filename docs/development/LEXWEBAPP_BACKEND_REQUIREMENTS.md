# Lexwebapp Backend Requirements for Development

## Analysis Date: 2026-01-21
## Frontend Location: `/Users/vovkes/ZOMCP/SecondLayer/Lexwebapp`
## Backend Target: Development environment (dev.legal.org.ua)

---

## 📊 Implementation Status Overview

| Category | Endpoints | Status | Priority |
|----------|-----------|--------|----------|
| **Authentication** | 6 endpoints | ⚠️ Partial (50%) | 🔴 HIGH |
| **MCP Tools API** | 9 tools | ✅ Complete (100%) | ✅ Done |
| **Judges Database** | 5 endpoints | ❌ Not Implemented (0%) | 🟡 MEDIUM |
| **Lawyers Database** | 5 endpoints | ❌ Not Implemented (0%) | 🟡 MEDIUM |
| **Clients Management** | 5 endpoints | ❌ Not Implemented (0%) | 🟢 LOW |
| **Cases Management** | 5 endpoints | ❌ Not Implemented (0%) | 🟢 LOW |
| **Chat History** | 4 endpoints | ❌ Not Implemented (0%) | 🟢 LOW |
| **Messaging System** | 3 endpoints | ❌ Not Implemented (0%) | 🟢 LOW |

**Overall Progress:** 9/41 endpoints (22% complete)

---

## 🔴 HIGH PRIORITY - Authentication & Core Security

### ✅ ALREADY IMPLEMENTED

1. **User Authentication Tables** ✓
   - `users` table exists (migration 006)
   - `user_sessions` table exists
   - Google OAuth backend code exists

2. **Backend Routes** ✓
   - `GET /health` ✓
   - OAuth infrastructure exists in `src/routes/auth.ts`

### ❌ NEEDS IMPLEMENTATION

3. **Google OAuth Flow - INCOMPLETE**

**Missing Endpoints:**
```typescript
// File: mcp_backend/src/routes/auth.ts

// ✅ ALREADY EXISTS: GET /auth/google
// ✅ ALREADY EXISTS: GET /auth/google/callback
// ❌ MISSING: POST /api/auth/logout (JWT required)
// ❌ MISSING: POST /api/auth/refresh (JWT required)
// ❌ MISSING: PUT /api/auth/profile (JWT required)
```

**Required Implementation:**

#### A. Fix Logout Endpoint
```typescript
// Location: mcp_backend/src/routes/auth.ts
// Add after login routes

router.post('/logout', authenticateJWT, async (req, res) => {
  try {
    const userId = req.user.id;

    // Delete user's session from database
    await pool.query(
      'DELETE FROM user_sessions WHERE user_id = $1',
      [userId]
    );

    res.json({
      success: true,
      message: 'Logged out successfully'
    });
  } catch (error) {
    logger.error('Logout error:', error);
    res.status(500).json({
      success: false,
      error: 'Logout failed'
    });
  }
});
```

#### B. Add Token Refresh Endpoint
```typescript
// Location: mcp_backend/src/routes/auth.ts

router.post('/refresh', authenticateJWT, async (req, res) => {
  try {
    const userId = req.user.id;

    // Get user from database
    const userResult = await pool.query(
      'SELECT * FROM users WHERE id = $1',
      [userId]
    );

    if (userResult.rows.length === 0) {
      return res.status(404).json({
        success: false,
        error: 'User not found'
      });
    }

    const user = userResult.rows[0];

    // Generate new JWT token (7 days expiry)
    const newToken = jwt.sign(
      {
        id: user.id,
        email: user.email,
        name: user.name
      },
      process.env.JWT_SECRET,
      { expiresIn: '7d' }
    );

    // Update session in database
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
    await pool.query(
      'UPDATE user_sessions SET session_token = $1, expires_at = $2 WHERE user_id = $3',
      [newToken, expiresAt, userId]
    );

    res.json({
      token: newToken,
      expiresIn: '7d'
    });
  } catch (error) {
    logger.error('Token refresh error:', error);
    res.status(500).json({
      success: false,
      error: 'Token refresh failed'
    });
  }
});
```

#### C. Add Profile Update Endpoint
```typescript
// Location: mcp_backend/src/routes/auth.ts

router.put('/profile', authenticateJWT, async (req, res) => {
  try {
    const userId = req.user.id;
    const { name, picture } = req.body;

    // Build dynamic update query
    const updates = [];
    const values = [];
    let paramIndex = 1;

    if (name !== undefined) {
      updates.push(`name = $${paramIndex++}`);
      values.push(name);
    }

    if (picture !== undefined) {
      updates.push(`picture = $${paramIndex++}`);
      values.push(picture);
    }

    if (updates.length === 0) {
      return res.status(400).json({
        success: false,
        error: 'No updates provided'
      });
    }

    // Add updated_at
    updates.push(`updated_at = CURRENT_TIMESTAMP`);
    values.push(userId);

    // Execute update
    const result = await pool.query(
      `UPDATE users SET ${updates.join(', ')} WHERE id = $${paramIndex} RETURNING *`,
      values
    );

    res.json({
      user: result.rows[0]
    });
  } catch (error) {
    logger.error('Profile update error:', error);
    res.status(500).json({
      success: false,
      error: 'Profile update failed'
    });
  }
});
```

#### D. Fix Frontend Redirect After OAuth
```typescript
// Location: mcp_backend/src/routes/auth.ts
// In the /auth/google/callback handler

// CURRENT CODE (likely exists):
res.redirect(`${process.env.FRONTEND_URL}/?token=${token}`);

// SHOULD BE:
res.redirect(`${process.env.FRONTEND_URL}/?token=${token}`);
// Frontend expects token in query string ✓

// Make sure FRONTEND_URL is set:
// Development: FRONTEND_URL=https://dev.legal.org.ua
// Production: FRONTEND_URL=https://legal.org.ua
```

**Environment Variables to Add:**
```bash
# In mcp_backend/.env for development

# Google OAuth (should already exist)
GOOGLE_CLIENT_ID=YOUR_GOOGLE_CLIENT_ID
GOOGLE_CLIENT_SECRET=YOUR_GOOGLE_CLIENT_SECRET
GOOGLE_CALLBACK_URL=http://localhost:3000/auth/google/callback

# JWT (should already exist)
JWT_SECRET=YOUR_JWT_SECRET_64_CHARS

# Frontend URL for OAuth redirect
FRONTEND_URL=https://dev.legal.org.ua

# CORS - Add dev subdomain
ALLOWED_ORIGINS=http://localhost:5173,http://localhost:3000,https://dev.legal.org.ua,https://legal.org.ua
```

---

## ✅ COMPLETE - MCP Tools API

**All 9 MCP tools are already implemented and working:**

1. ✅ `POST /api/tools/search_legal_precedents`
2. ✅ `POST /api/tools/analyze_case_pattern`
3. ✅ `POST /api/tools/get_legal_advice` (with SSE streaming)
4. ✅ `POST /api/tools/extract_document_sections`
5. ✅ `POST /api/tools/get_similar_reasoning`
6. ✅ `POST /api/tools/find_relevant_law_articles`
7. ✅ `POST /api/tools/check_precedent_status`
8. ✅ `POST /api/tools/get_citation_graph`
9. ✅ `GET /api/tools` (list all tools)

**Supporting Endpoints:**
- ✅ `POST /api/tools/:toolName` (generic execution)
- ✅ SSE streaming support with `Accept: text/event-stream`
- ✅ `POST /api/tools/batch` (batch execution)

**No changes needed - fully functional!**

---

## 🟡 MEDIUM PRIORITY - Judges & Lawyers Databases

### Current Status: Frontend uses **MOCK DATA**

The frontend has complete UI for judges and lawyers management but backend has no real data.

### Database Schema Needed

#### Create Judges Table
```sql
-- File: mcp_backend/src/migrations/007_add_judges_table.sql

CREATE TABLE IF NOT EXISTS judges (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  name VARCHAR(255) NOT NULL,
  court VARCHAR(255) NOT NULL,
  total_cases INTEGER DEFAULT 0,
  approval_rate NUMERIC(5, 2),  -- Percentage (0-100)
  avg_duration_days INTEGER,
  specialization VARCHAR(255),
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_judges_name ON judges(name);
CREATE INDEX IF NOT EXISTS idx_judges_court ON judges(court);
CREATE INDEX IF NOT EXISTS idx_judges_specialization ON judges(specialization);

-- Trigger for auto-updating updated_at
CREATE TRIGGER update_judges_updated_at BEFORE UPDATE ON judges
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
```

#### Create Lawyers Table
```sql
-- File: mcp_backend/src/migrations/007_add_judges_table.sql (continued)

CREATE TABLE IF NOT EXISTS lawyers (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  name VARCHAR(255) NOT NULL,
  firm VARCHAR(255),
  total_cases INTEGER DEFAULT 0,
  success_rate NUMERIC(5, 2),  -- Percentage (0-100)
  specialization VARCHAR(255),
  email VARCHAR(255),
  phone VARCHAR(50),
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_lawyers_name ON lawyers(name);
CREATE INDEX IF NOT EXISTS idx_lawyers_firm ON lawyers(firm);
CREATE INDEX IF NOT EXISTS idx_lawyers_specialization ON lawyers(specialization);

-- Trigger for auto-updating updated_at
CREATE TRIGGER update_lawyers_updated_at BEFORE UPDATE ON lawyers
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
```

### API Endpoints to Implement

#### Judges CRUD API
```typescript
// File: mcp_backend/src/routes/judges.ts (NEW FILE)

import { Router } from 'express';
import { authenticateJWT } from '../middleware/jwt-auth.js';
import { pool } from '../utils/database.js';

const router = Router();

// GET /api/judges - List judges with filtering
router.get('/', authenticateJWT, async (req, res) => {
  try {
    const { search, court, specialization, limit = 50, offset = 0 } = req.query;

    let query = 'SELECT * FROM judges WHERE 1=1';
    const params = [];
    let paramIndex = 1;

    if (search) {
      query += ` AND (name ILIKE $${paramIndex} OR court ILIKE $${paramIndex})`;
      params.push(`%${search}%`);
      paramIndex++;
    }

    if (court) {
      query += ` AND court = $${paramIndex}`;
      params.push(court);
      paramIndex++;
    }

    if (specialization) {
      query += ` AND specialization = $${paramIndex}`;
      params.push(specialization);
      paramIndex++;
    }

    query += ` ORDER BY name LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`;
    params.push(limit, offset);

    const result = await pool.query(query, params);

    res.json({
      success: true,
      data: result.rows,
      total: result.rowCount
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// GET /api/judges/:id - Get single judge
router.get('/:id', authenticateJWT, async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT * FROM judges WHERE id = $1',
      [req.params.id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'Judge not found' });
    }

    res.json({ success: true, data: result.rows[0] });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// POST /api/judges - Create judge
router.post('/', authenticateJWT, async (req, res) => {
  try {
    const { name, court, total_cases, approval_rate, avg_duration_days, specialization } = req.body;

    const result = await pool.query(
      `INSERT INTO judges (name, court, total_cases, approval_rate, avg_duration_days, specialization)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [name, court, total_cases || 0, approval_rate, avg_duration_days, specialization]
    );

    res.status(201).json({ success: true, data: result.rows[0] });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// PUT /api/judges/:id - Update judge
router.put('/:id', authenticateJWT, async (req, res) => {
  try {
    const { name, court, total_cases, approval_rate, avg_duration_days, specialization } = req.body;

    const result = await pool.query(
      `UPDATE judges SET
        name = COALESCE($1, name),
        court = COALESCE($2, court),
        total_cases = COALESCE($3, total_cases),
        approval_rate = COALESCE($4, approval_rate),
        avg_duration_days = COALESCE($5, avg_duration_days),
        specialization = COALESCE($6, specialization)
       WHERE id = $7 RETURNING *`,
      [name, court, total_cases, approval_rate, avg_duration_days, specialization, req.params.id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'Judge not found' });
    }

    res.json({ success: true, data: result.rows[0] });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// DELETE /api/judges/:id - Delete judge
router.delete('/:id', authenticateJWT, async (req, res) => {
  try {
    const result = await pool.query(
      'DELETE FROM judges WHERE id = $1 RETURNING id',
      [req.params.id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'Judge not found' });
    }

    res.json({ success: true, message: 'Judge deleted' });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

export default router;
```

#### Lawyers CRUD API (Similar to Judges)
```typescript
// File: mcp_backend/src/routes/lawyers.ts (NEW FILE)
// Implementation similar to judges.ts - replace "judges" with "lawyers"
// and adjust fields accordingly
```

#### Register Routes in Main HTTP Server
```typescript
// File: mcp_backend/src/http-server.ts

import judgesRouter from './routes/judges.js';
import lawyersRouter from './routes/lawyers.js';

// Add after auth routes
app.use('/api/judges', judgesRouter);
app.use('/api/lawyers', lawyersRouter);
```

### Seed Data for Development
```typescript
// File: mcp_backend/scripts/seed-judges-lawyers.ts

import { pool } from '../src/utils/database.js';

async function seedJudges() {
  const judges = [
    {
      name: 'Іванов Іван Іванович',
      court: 'Київський апеляційний суд',
      total_cases: 245,
      approval_rate: 62.5,
      avg_duration_days: 135,
      specialization: 'Цивільні справи'
    },
    {
      name: 'Петренко Марія Олексіївна',
      court: 'Господарський суд Київської області',
      total_cases: 312,
      approval_rate: 71.3,
      avg_duration_days: 98,
      specialization: 'Господарські спори'
    },
    // Add more...
  ];

  for (const judge of judges) {
    await pool.query(
      `INSERT INTO judges (name, court, total_cases, approval_rate, avg_duration_days, specialization)
       VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT DO NOTHING`,
      [judge.name, judge.court, judge.total_cases, judge.approval_rate, judge.avg_duration_days, judge.specialization]
    );
  }

  console.log(`Seeded ${judges.length} judges`);
}

async function seedLawyers() {
  const lawyers = [
    {
      name: 'Сидоров Петро Миколайович',
      firm: 'Правова Група "Справедливість"',
      total_cases: 178,
      success_rate: 68.5,
      specialization: 'Корпоративне право'
    },
    // Add more...
  ];

  for (const lawyer of lawyers) {
    await pool.query(
      `INSERT INTO lawyers (name, firm, total_cases, success_rate, specialization)
       VALUES ($1, $2, $3, $4, $5) ON CONFLICT DO NOTHING`,
      [lawyer.name, lawyer.firm, lawyer.total_cases, lawyer.success_rate, lawyer.specialization]
    );
  }

  console.log(`Seeded ${lawyers.length} lawyers`);
}

async function main() {
  await seedJudges();
  await seedLawyers();
  await pool.end();
}

main().catch(console.error);
```

---

## 🟢 LOW PRIORITY - CRM Features (Clients, Cases, Chat, Messaging)

### Status: Frontend uses **MOCK DATA** - Can be deferred

These features are complete in the frontend but not critical for the core legal analysis functionality. They can be implemented later as time permits.

### Required Tables (For Future Implementation)

```sql
-- File: mcp_backend/src/migrations/008_add_crm_tables.sql

-- Clients table
CREATE TABLE IF NOT EXISTS clients (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  name VARCHAR(255) NOT NULL,
  company VARCHAR(255),
  email VARCHAR(255),
  phone VARCHAR(50),
  type VARCHAR(20) CHECK (type IN ('individual', 'corporate')),
  status VARCHAR(20) CHECK (status IN ('active', 'inactive')),
  active_cases INTEGER DEFAULT 0,
  last_contact TIMESTAMP,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Cases table
CREATE TABLE IF NOT EXISTS cases (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  client_id UUID REFERENCES clients(id) ON DELETE CASCADE,
  case_number VARCHAR(100) NOT NULL,
  title VARCHAR(500) NOT NULL,
  judge_id UUID REFERENCES judges(id),
  status VARCHAR(50) CHECK (status IN ('active', 'pending', 'closed', 'appeal')),
  category VARCHAR(100),
  court VARCHAR(255),
  next_hearing TIMESTAMP,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Chat conversations
CREATE TABLE IF NOT EXISTS chat_conversations (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  title VARCHAR(500),
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Chat messages
CREATE TABLE IF NOT EXISTS chat_messages (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  conversation_id UUID REFERENCES chat_conversations(id) ON DELETE CASCADE,
  role VARCHAR(20) CHECK (role IN ('user', 'assistant')),
  content TEXT NOT NULL,
  metadata JSONB,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Client messages (internal messaging system)
CREATE TABLE IF NOT EXISTS client_messages (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  sender_id UUID REFERENCES users(id) ON DELETE CASCADE,
  client_id UUID REFERENCES clients(id) ON DELETE CASCADE,
  subject VARCHAR(500),
  content TEXT NOT NULL,
  sent_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  read BOOLEAN DEFAULT false
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_clients_user_id ON clients(user_id);
CREATE INDEX IF NOT EXISTS idx_cases_user_id ON cases(user_id);
CREATE INDEX IF NOT EXISTS idx_cases_client_id ON cases(client_id);
CREATE INDEX IF NOT EXISTS idx_chat_conversations_user_id ON chat_conversations(user_id);
CREATE INDEX IF NOT EXISTS idx_chat_messages_conversation_id ON chat_messages(conversation_id);
CREATE INDEX IF NOT EXISTS idx_client_messages_sender ON client_messages(sender_id);
CREATE INDEX IF NOT EXISTS idx_client_messages_client ON client_messages(client_id);
```

### API Endpoints (Deferred)

**Clients CRUD**: 5 endpoints
- `GET /api/clients`
- `GET /api/clients/:id`
- `POST /api/clients`
- `PUT /api/clients/:id`
- `DELETE /api/clients/:id`

**Cases CRUD**: 5 endpoints
- `GET /api/cases`
- `GET /api/cases/:id`
- `POST /api/cases`
- `PUT /api/cases/:id`
- `DELETE /api/cases/:id`

**Chat History**: 4 endpoints
- `GET /api/chat/history`
- `POST /api/chat/conversations`
- `GET /api/chat/conversations/:id`
- `DELETE /api/chat/conversations/:id`

**Messaging**: 3 endpoints
- `POST /api/messages/send`
- `GET /api/messages`
- `GET /api/messages/threads/:clientId`

**Recommendation:** Implement these only after authentication and judges/lawyers are complete and tested.

---

## 📋 Implementation Checklist for Development

### Phase 1: Authentication (1-2 days) 🔴 HIGH

- [ ] Add `POST /api/auth/logout` endpoint
- [ ] Add `POST /api/auth/refresh` endpoint
- [ ] Add `PUT /api/auth/profile` endpoint
- [ ] Test OAuth flow from dev.legal.org.ua
- [ ] Verify JWT token refresh works
- [ ] Test profile updates
- [ ] Update CORS settings for dev subdomain
- [ ] Set FRONTEND_URL environment variable

### Phase 2: Judges & Lawyers (2-3 days) 🟡 MEDIUM

- [ ] Create migration 007 with judges and lawyers tables
- [ ] Apply migration to development database
- [ ] Implement `/api/judges` CRUD routes
- [ ] Implement `/api/lawyers` CRUD routes
- [ ] Register routes in http-server.ts
- [ ] Create seed script with sample data
- [ ] Run seed script on development
- [ ] Test all CRUD operations from frontend

### Phase 3: Testing & Verification (1 day)

- [ ] Test complete user flow: Login → Search → View Judges → View Lawyers
- [ ] Verify SSE streaming works for legal advice
- [ ] Check all MCP tools work correctly
- [ ] Test error handling and authentication failures
- [ ] Performance testing with real data
- [ ] Update API documentation

### Phase 4: Optional CRM Features (5-7 days) 🟢 LOW

- [ ] Create migration 008 with CRM tables
- [ ] Implement Clients CRUD
- [ ] Implement Cases CRUD
- [ ] Implement Chat History
- [ ] Implement Messaging System
- [ ] Test complete CRM workflow

---

## 🚀 Quick Start for Development

### 1. Apply Authentication Fixes
```bash
cd /Users/vovkes/ZOMCP/SecondLayer/mcp_backend

# Edit src/routes/auth.ts and add missing endpoints
# (logout, refresh, profile)

# Restart development backend
ssh gate "docker restart secondlayer-app-dev"
```

### 2. Create Judges & Lawyers Tables
```bash
# Create migration file
cat > src/migrations/007_add_judges_lawyers.sql <<EOF
# (Paste SQL from above)
EOF

# Copy to gate server
scp src/migrations/007_add_judges_lawyers.sql gate:/tmp/

# Apply migration
ssh gate "docker cp /tmp/007_add_judges_lawyers.sql secondlayer-postgres-dev:/tmp/"
ssh gate "docker exec secondlayer-postgres-dev psql -U secondlayer -d secondlayer_db -f /tmp/007_add_judges_lawyers.sql"
```

### 3. Add API Routes
```bash
# Create new route files
touch src/routes/judges.ts
touch src/routes/lawyers.ts

# Implement CRUD operations (see code above)

# Register routes in http-server.ts

# Rebuild and restart
npm run build
ssh gate "docker restart secondlayer-app-dev"
```

### 4. Seed Development Data
```bash
# Create seed script
node scripts/seed-judges-lawyers.ts

# Or seed via SQL
ssh gate "docker exec secondlayer-postgres-dev psql -U secondlayer -d secondlayer_db -f /tmp/seed-data.sql"
```

### 5. Test from Frontend
```bash
# Visit dev.legal.org.ua
# Login with Google
# Navigate to "Судді" or "Юристи" pages
# Verify real data loads instead of mock data
```

---

## 📞 Support & Documentation

**Related Files:**
- Frontend API Client: `Lexwebapp/src/services/api-client.ts`
- Frontend Types: `Lexwebapp/src/types/api.ts`
- Backend Auth Routes: `mcp_backend/src/routes/auth.ts`
- Backend HTTP Server: `mcp_backend/src/http-server.ts`
- Database Migrations: `mcp_backend/src/migrations/`

**Environment Setup:**
- Dev Backend: https://dev.legal.org.ua/
- Dev Frontend: https://dev.legal.org.ua/
- Health Check: https://dev.legal.org.ua/health
- API Docs: Will be generated after implementation

---

**Status:** 📝 Ready for Implementation
**Priority Order:** Authentication → Judges/Lawyers → (Optional) CRM
**Estimated Time:** 3-5 days for core features (Phases 1-2)
