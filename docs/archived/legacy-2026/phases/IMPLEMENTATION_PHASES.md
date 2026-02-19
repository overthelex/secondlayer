# P0 Critical Features — Implementation Phases

## Overview

Legal practice management platform upgrade: 4 phases, ~5,500 lines of code per phase.

| Phase | Feature | Status | Backend | Frontend | Migration |
|-------|---------|--------|---------|----------|-----------|
| **1** | Time Tracking & Billing | ✅ Code complete | 1,762 LOC | 3,799 LOC | 037 |
| **2** | Tasks, Deadlines & Documents | ⬜ Not started | — | — | 038-039 |
| **3** | Communication Hub | ⬜ Not started | — | — | 040-041 |
| **4** | Client Portal | ⬜ Not started | — | — | 042 |

---

## Phase 1: Time Tracking & Billing ✅

### What it does
- Track billable hours with start/stop timers
- Time entry workflow: draft → submitted → approved → invoiced
- Generate PDF invoices from approved time entries
- Record payments, partial payments, void invoices
- Billing rates per user with effective date ranges

### Backend files created

| File | Purpose | Lines |
|------|---------|-------|
| `mcp_backend/src/migrations/037_add_time_billing.sql` | Schema: 6 tables, triggers, functions | 391 |
| `mcp_backend/src/services/time-entry-service.ts` | CRUD, timers, workflow, billing rates | 653 |
| `mcp_backend/src/services/matter-invoice-service.ts` | Invoices, PDF generation, payments | 626 |
| `mcp_backend/src/routes/time-entry-routes.ts` | REST API for time entries & timers | 303 |
| `mcp_backend/src/routes/invoice-routes.ts` | REST API for invoices & payments | 180 |

**Modified:** `mcp_backend/src/http-server.ts` — registered new routes and services

### Frontend files created

| File | Purpose | Lines |
|------|---------|-------|
| `lexwebapp/src/pages/TimeEntriesPage/index.tsx` | List, filter, manage time entries | 428 |
| `lexwebapp/src/pages/InvoicesPage/index.tsx` | List, filter, manage invoices | 411 |
| `lexwebapp/src/components/time/TimeTrackerWidget.tsx` | Floating timer widget | 168 |
| `lexwebapp/src/components/time/CreateTimeEntryModal.tsx` | Create/edit time entry form | 231 |
| `lexwebapp/src/components/invoices/GenerateInvoiceModal.tsx` | Generate invoice from entries | 300 |
| `lexwebapp/src/components/invoices/InvoiceDetailModal.tsx` | View invoice, record payments | 387 |
| `lexwebapp/src/services/api/TimeEntryService.ts` | API client for time endpoints | 241 |
| `lexwebapp/src/services/api/InvoiceService.ts` | API client for invoice endpoints | 174 |
| `lexwebapp/src/hooks/queries/useTimeEntries.ts` | 12 React Query hooks | 220 |
| `lexwebapp/src/hooks/queries/useInvoices.ts` | 7 React Query hooks | 125 |
| `lexwebapp/src/stores/timerStore.ts` | Zustand store, background ping | 168 |
| `lexwebapp/src/types/models/TimeEntry.ts` | TypeScript interfaces | 140 |

**Modified:** `router/routes.ts`, `router/index.tsx`, `layouts/MainLayout.tsx`, `components/Sidebar.tsx`, `hooks/queries/index.ts`, `stores/index.ts`, `types/models/index.ts`, `lib/react-query.ts`

### Database tables (Migration 037)

| Table | Purpose |
|-------|---------|
| `time_entries` | Billable hours with status workflow |
| `active_timers` | Running timers (one per user per matter) |
| `user_billing_rates` | Hourly rates with effective dates |
| `matter_invoices` | Invoice headers (INV-YYYY-NNNN) |
| `invoice_line_items` | Line items per invoice |
| `invoice_payments` | Payment records |

**Functions:** `generate_invoice_number()`, `cleanup_stale_timers()`, `get_user_billing_rate()`, `calculate_invoice_totals()`

**Triggers:** Auto-update timestamps, recalculate totals on line item change, update payment status

### API Endpoints

```
POST   /api/time/entries              — Create time entry
GET    /api/time/entries              — List (filters: matter, user, status, date, billable)
PUT    /api/time/entries/:id          — Update draft/rejected entry
DELETE /api/time/entries/:id          — Delete draft entry
POST   /api/time/entries/:id/submit   — Submit for approval
POST   /api/time/entries/:id/approve  — Approve
POST   /api/time/entries/:id/reject   — Reject with notes
POST   /api/time/timers/start         — Start timer
POST   /api/time/timers/stop          — Stop timer → create entry
GET    /api/time/timers/active        — Get user's active timers
POST   /api/time/timers/ping          — Keep-alive ping
GET    /api/time/rates/:userId        — Get current billing rate
POST   /api/time/rates/:userId        — Set billing rate
GET    /api/time/rates/:userId/history — Rate history

POST   /api/invoicing/generate        — Generate from time entries
GET    /api/invoicing/invoices         — List invoices
GET    /api/invoicing/invoices/:id     — Get invoice with details
GET    /api/invoicing/invoices/:id/pdf — Download PDF
POST   /api/invoicing/invoices/:id/send    — Mark as sent
POST   /api/invoicing/invoices/:id/payment — Record payment
POST   /api/invoicing/invoices/:id/void    — Void invoice
```

### Build status
- Backend: ✅ compiles
- Frontend: ✅ builds (4.25s, 2MB bundle)
- Migration: ⚠️ needs `npm run migrate` on running DB

### Deployment checklist
- [ ] `npm install pdfkit @types/pdfkit` (already installed)
- [ ] Run migration 037
- [ ] Start backend: `npm run dev:http`
- [ ] Start frontend: `npm run dev`
- [ ] Smoke test: timer → stop → submit → approve → invoice → PDF → payment

---

## Phase 2: Tasks, Deadlines & Document Management ⬜

### What it does
- Task management with Kanban board (Pending → In Progress → Completed)
- Court deadlines and filing dates with calendar view
- Document browser with folders, versions, search
- Drag-and-drop task board using `@dnd-kit/core`

### Backend — to create

**Migration 038** — `038_add_tasks_deadlines.sql`

| Table | Purpose |
|-------|---------|
| `tasks` | Status, priority, assignee, due date, matter link |
| `matter_deadlines` | Court dates, filing deadlines with reminders |
| `task_comments` | Comments on tasks |

**Migration 039** — `039_add_document_management.sql`

| Change | Purpose |
|--------|---------|
| ALTER `documents` | Add `folder_path`, `parent_folder_id`, `is_folder`, `tags`, `version_number` |
| `document_shares` | Permission-based document sharing |

**Services:**

| File | Methods |
|------|---------|
| `task-service.ts` | `createTask`, `updateTask`, `deleteTask`, `listTasks`, `assignTask`, `completeTask`, `createDeadline`, `getUpcomingDeadlines`, `addComment` |
| Enhanced `document-service.ts` | `createFolder`, `moveDocument`, `listDocumentsInFolder`, `createVersion`, `getVersionHistory`, `searchDocuments`, `shareDocument` |

**Routes:**

| File | Prefix |
|------|--------|
| `task-routes.ts` | `/api/tasks` |
| Enhanced `document-routes.ts` | `/api/documents` |

### Frontend — to create

| Component | Purpose |
|-----------|---------|
| `TaskBoard.tsx` | Kanban columns with drag-and-drop |
| `TaskListView.tsx` | Table view with sorting |
| `CalendarView.tsx` | Monthly calendar for deadlines |
| `DocumentBrowser.tsx` | Folder tree + file grid/list |
| `DocumentUploadModal.tsx` | Reuse existing UploadService/UploadStore |
| `TasksPage/index.tsx` | Main tasks page |
| `CalendarPage/index.tsx` | Calendar page |

**Dependencies to install:** `@dnd-kit/core @dnd-kit/sortable`

**Routes to add:** `/tasks`, `/calendar`

### API Endpoints (planned)

```
POST   /api/tasks                — Create task
GET    /api/tasks                — List (filters: matter, assignee, status, priority)
PUT    /api/tasks/:id            — Update task
DELETE /api/tasks/:id            — Delete task
POST   /api/tasks/:id/assign     — Assign to user
POST   /api/tasks/:id/complete   — Mark completed
POST   /api/tasks/:id/comments   — Add comment
GET    /api/tasks/:id/comments   — Get comments

POST   /api/deadlines            — Create deadline
GET    /api/deadlines            — List upcoming
PUT    /api/deadlines/:id        — Update deadline
DELETE /api/deadlines/:id        — Delete deadline

POST   /api/documents/folders    — Create folder
PUT    /api/documents/:id/move   — Move document/folder
GET    /api/documents/browse     — List documents in folder
GET    /api/documents/:id/versions — Version history
POST   /api/documents/:id/share  — Share with users
```

---

## Phase 3: Communication Hub ⬜

### What it does
- Internal team messaging per matter
- @mention support with notifications
- Read receipts
- In-app notification system with bell icon
- Email integration (SMTP)

### Backend — to create

**Migration 040** — `040_add_matter_messages.sql`

| Table | Purpose |
|-------|---------|
| `matter_messages` | Internal team + client messages |
| `message_mentions` | @mentions tracking |
| `message_read_receipts` | Read status per user |

**Migration 041** — `041_add_notifications.sql`

| Table | Purpose |
|-------|---------|
| `notifications` | In-app notification system |

**Services:**

| File | Methods |
|------|---------|
| `message-service.ts` | `sendMessage`, `getMessages`, `getMessageThread`, `markAsRead`, `sendEmailToClient`, `extractMentions`, `notifyMentions` |
| `notification-service.ts` | `createNotification`, `getNotifications`, `markAsRead`, `markAllAsRead`, `getUnreadCount` |

**Routes:**

| File | Prefix |
|------|--------|
| `message-routes.ts` | `/api/messages` |
| `notification-routes.ts` | `/api/notifications` |

### Frontend — to create

| Component | Purpose |
|-----------|---------|
| `MessageThread.tsx` | Threaded conversation view |
| `MessageComposer.tsx` | Text area with @mention, file attach |
| `NotificationBell.tsx` | Header bell with badge count + dropdown |
| `MessagesPage/index.tsx` | Full messaging page (left: matter list, main: thread) |

**Polling:** React Query `refetchInterval: 5000` for messages, `10000` for notifications

### API Endpoints (planned)

```
POST   /api/messages/:matterId        — Send message
GET    /api/messages/:matterId        — Get messages
POST   /api/messages/:id/read         — Mark as read
POST   /api/messages/:matterId/email  — Send email to client

GET    /api/notifications             — Get notifications
POST   /api/notifications/read-all    — Mark all as read
POST   /api/notifications/:id/read    — Mark single as read
GET    /api/notifications/unread-count — Badge count
```

### Environment variables needed

```bash
SMTP_HOST=smtp.gmail.com
SMTP_PORT=587
SMTP_USER=noreply@yourfirm.com
SMTP_PASS=...
SMTP_FROM="Law Firm <noreply@yourfirm.com>"
```

---

## Phase 4: Client Portal ⬜

### What it does
- Separate client-facing portal with restricted access
- Magic link authentication (no password needed)
- Clients can view their matters, documents, invoices
- E-signature request/tracking
- Read-only matter overview

### Backend — to create

**Migration 042** — `042_add_client_portal.sql`

| Table | Purpose |
|-------|---------|
| `client_users` | Separate user accounts for clients |
| `client_matter_access` | Access control per matter |
| `signature_requests` | E-signature tracking |

**Services:**

| File | Methods |
|------|---------|
| `client-portal-service.ts` | `createClientUser`, `authenticateClientUser`, `sendMagicLink`, `verifyMagicLink`, `grantMatterAccess`, `revokeMatterAccess`, `getAccessibleMatters`, `checkAccess`, `requestSignature`, `signDocument` |

**Middleware:** `client-auth.ts` — `requireClientJWT` (separate JWT from internal users)

**Routes:**

| File | Prefix |
|------|--------|
| `client-portal-routes.ts` | `/api/client-portal` |

### Frontend — to create

| Component | Purpose |
|-----------|---------|
| `ClientPortalLayout.tsx` | Separate layout from main app |
| `ClientPortalLogin/index.tsx` | Email + magic link login |
| `ClientMatterView/index.tsx` | Read-only matter overview |
| `ClientDocumentsView.tsx` | Document browser (download only) |
| `ClientInvoicesView.tsx` | Invoice list with PDF download |

**Router:** Separate route prefix `/client-portal/*` with `ClientPortalGuard`

### API Endpoints (planned)

```
POST   /api/client-portal/auth/login       — Email/password login
POST   /api/client-portal/auth/magic-link   — Request magic link
GET    /api/client-portal/auth/verify       — Verify magic link token
GET    /api/client-portal/matters           — List accessible matters
GET    /api/client-portal/matters/:id       — View matter details
GET    /api/client-portal/matters/:id/docs  — View matter documents
GET    /api/client-portal/invoices          — View invoices
GET    /api/client-portal/invoices/:id/pdf  — Download invoice PDF
POST   /api/client-portal/signatures/:id    — Sign document
POST   /api/client-portal/signatures/:id/decline — Decline signature
```

### Environment variables needed

```bash
CLIENT_JWT_SECRET=<separate-secret>
CLIENT_JWT_EXPIRY=24h
MAGIC_LINK_EXPIRY_MINUTES=15
```

---

## Architectural Decisions

| Decision | Choice | Reason |
|----------|--------|--------|
| Timer storage | Database + 60s ping | Survives crashes, works across devices |
| PDF generation | Server-side `pdfkit` | Consistent rendering, can email/archive |
| Document storage | Existing UploadService + MinIO | Already battle-tested with chunked uploads |
| Task drag-and-drop | `@dnd-kit/core` | Modern, accessible, TS support |
| Client auth | Magic links primary | Better UX for non-technical clients |
| Messaging | React Query polling (5s) | Simpler than WebSocket, acceptable latency |
| Email | SMTP via nodemailer | Unified message history, no external costs |

---

## Existing Code Reused

| What | Where |
|------|-------|
| Upload system | `lexwebapp/src/services/api/UploadService.ts`, `stores/uploadStore.ts` |
| Modal pattern | `lexwebapp/src/components/ui/Modal/Modal.tsx` |
| Form pattern | `lexwebapp/src/components/matters/CreateMatterModal.tsx` |
| List pattern | `lexwebapp/src/components/ClientsPage.tsx` |
| Detail pattern | `lexwebapp/src/components/ClientDetailPage.tsx` |
| Audit service | `mcp_backend/src/services/audit-service.ts` |
| Matter access | `mcp_backend/src/middleware/matter-access.ts` |
| Auth middleware | `mcp_backend/src/middleware/dual-auth.ts` |

---

## Testing Strategy

### Phase 1 (37 tests documented in PHASE1_TESTING.md)
- Timer flow: start → ping → stop → verify entry
- Workflow: draft → submit → approve → invoice
- Invoice: generate → download PDF → record payment
- Edge cases: stale timers, void invoice, concurrent timers

### Phase 2
- Task board: create → drag → assign → complete
- Document: upload → folder → move → version → download
- Calendar: create deadline → verify display → reminder

### Phase 3
- Message: send with @mention → notification created
- Email: send → stored in matter_messages → delivered
- Notification: create → badge count → click → navigate

### Phase 4
- Client login: magic link → JWT → expires correctly
- Access control: granted Matter A → can view A → cannot view B (403)
- Invoice: client views → downloads PDF
- Security: client cannot access attorney endpoints

### End-to-End
Start timer → work 2h → stop → submit → approve → generate invoice → send to client → client views in portal → record payment → status = paid

---

## Deployment Order

```
Phase 1: migrate 037 → deploy backend → deploy frontend → smoke test
Phase 2: migrate 038-039 → install @dnd-kit → deploy → smoke test
Phase 3: migrate 040-041 → configure SMTP → deploy → smoke test
Phase 4: migrate 042 → generate CLIENT_JWT_SECRET → deploy → smoke test
```
