# Phase 1: Time Tracking & Billing - Testing Guide

## Pre-Deployment Checklist

### 1. Backend Dependencies
```bash
cd /home/vovkes/SecondLayer/mcp_backend

# Check if pdfkit is installed
npm list pdfkit

# If not installed, install it
npm install pdfkit @types/pdfkit
```

### 2. Database Migration
```bash
cd /home/vovkes/SecondLayer/mcp_backend

# Build the project first
npm run build

# Run migration 037
npm run migrate
```

Expected output:
```
✓ Migration 037_add_time_billing.sql applied successfully
```

### 3. Backend Build & Start
```bash
cd /home/vovkes/SecondLayer/mcp_backend

# Build
npm run build

# Start HTTP server
npm run dev:http
```

Expected: Server running on port 3000

### 4. Frontend Build & Start
```bash
cd /home/vovkes/SecondLayer/lexwebapp

# Install dependencies if needed
npm install

# Start dev server
npm run dev
```

Expected: Vite dev server on port 5173

---

## Testing Checklist

### A. Time Entry CRUD Operations

#### ✅ Test 1: Create Manual Time Entry
1. Navigate to **Time Entries** page (`/time-entries`)
2. Click **"New Entry"** button
3. Fill form:
   - Matter: Select any matter
   - Date: Today's date
   - Hours: 2, Minutes: 30
   - Description: "Client consultation"
   - Billable: ✓ Checked
4. Click **"Create Entry"**

**Expected Result:**
- Entry appears in list
- Status: Draft (gray badge)
- Duration: 2h 30m
- Amount calculated: `2.5 × hourly_rate`

#### ✅ Test 2: Update Time Entry
1. Find a draft entry
2. Click the entry row
3. Modify duration to 3h 0m
4. Save changes

**Expected Result:**
- Duration updated in list
- Amount recalculated

#### ✅ Test 3: Delete Time Entry
1. Find a draft entry
2. Click trash icon
3. Confirm deletion

**Expected Result:**
- Entry removed from list
- Total count decremented

---

### B. Timer Functionality

#### ✅ Test 4: Start Timer
1. From Time Entries page, click **"New Entry"**
2. Select a matter and description
3. Click **"Start Timer"** (or create entry then click Play icon)

**Expected Result:**
- **TimeTrackerWidget appears** in bottom-right corner
- Timer shows matter name
- Elapsed time: 0:00 (starts incrementing)
- Animated pulse indicator visible

#### ✅ Test 5: Multiple Timers
1. Start timer for Matter A
2. Navigate to different matter
3. Start timer for Matter B

**Expected Result:**
- Widget shows both timers
- Count badge: "Active Timers (2)"
- Both timers increment independently

#### ✅ Test 6: Timer Persistence
1. Start a timer
2. Refresh the page (F5)
3. Check widget

**Expected Result:**
- Timer still appears
- Elapsed time continues from last sync
- No duplicate timers

#### ✅ Test 7: Stop Timer
1. In widget, click **"Stop"** button on a timer
2. Check Time Entries list

**Expected Result:**
- Timer disappears from widget
- New draft time entry created
- Duration matches elapsed time (rounded up to nearest minute)
- Description matches timer description

---

### C. Time Entry Workflow

#### ✅ Test 8: Submit for Approval
1. Find a draft entry
2. Click **Send icon** (submit)

**Expected Result:**
- Status changes to: Submitted (blue badge)
- Entry no longer editable
- Send icon disappears

#### ✅ Test 9: Approve Time Entry
1. Find a submitted entry
2. Click **Approve** button

**Expected Result:**
- Status changes to: Approved (green badge)
- Entry ready for invoicing

#### ✅ Test 10: Reject Time Entry
1. Submit another draft entry
2. Click **Reject** button
3. Add notes: "Please add more details"

**Expected Result:**
- Status: Rejected (red badge)
- Can edit and resubmit

---

### D. Invoice Generation

#### ✅ Test 11: Generate Invoice from Time Entries
1. Navigate to **Invoices** page (`/invoices`)
2. Click **"Generate Invoice"**
3. Select matter with approved time entries
4. Check all unbilled entries
5. Set:
   - Due Days: 30
   - Tax Rate: 10%
   - Terms: "Payment due within 30 days"
6. Click **"Generate Invoice"**

**Expected Result:**
- Invoice created with auto-generated number (INV-2026-0001)
- Status: Draft
- Subtotal = sum of all selected entries
- Tax = subtotal × 10%
- Total = subtotal + tax
- Line items show each time entry
- Time entries marked as "invoiced"

#### ✅ Test 12: View Invoice Details
1. Click on invoice row
2. Modal opens

**Expected Result:**
- Invoice number, client, matter shown
- Issue date and due date visible
- Line items table populated
- Totals calculated correctly
- No payments yet

#### ✅ Test 13: Download Invoice PDF
1. In invoice detail modal, click **"Download PDF"**

**Expected Result:**
- PDF downloads (check Downloads folder)
- Filename: `INV-2026-0001.pdf`
- PDF contains:
  - Header: "INVOICE"
  - Invoice details (number, dates, status)
  - Bill To: Client/Matter
  - Line items table
  - Subtotal, Tax, Total
  - Payment terms and notes

#### ✅ Test 14: Send Invoice
1. Find draft invoice
2. Click **Send icon**
3. Confirm

**Expected Result:**
- Status changes to: Sent (blue badge)
- `sent_at` timestamp populated

---

### E. Payment Recording

#### ✅ Test 15: Record Full Payment
1. Open sent invoice
2. Click **"Record Payment"**
3. Fill form:
   - Amount: Full balance ($XXX.XX)
   - Payment Date: Today
   - Payment Method: "Credit Card"
   - Reference: "TXN-12345"
4. Click **"Record Payment"**

**Expected Result:**
- Payment appears in "Payment History"
- Amount Paid updated
- Balance Due: $0.00
- Status changes to: Paid (green badge)
- Green checkmark visible

#### ✅ Test 16: Record Partial Payment
1. Generate new invoice for $1000
2. Send it
3. Record payment for $600

**Expected Result:**
- Amount Paid: $600.00
- Balance Due: $400.00
- Status: Sent (not Paid yet)
- Payment in history

#### ✅ Test 17: Multiple Payments
1. Using invoice from Test 16
2. Record second payment: $400

**Expected Result:**
- Total Paid: $1000.00
- Balance: $0.00
- Status: Paid
- Two payments in history

---

### F. Billing Rates

#### ✅ Test 18: Set User Billing Rate
1. Open browser console
2. Check current user ID from auth token
3. Create time entry

**Expected Result:**
- Time entry uses correct hourly rate
- Rate should be from `user_billing_rates` table or default $0

#### ✅ Test 19: Verify Rate in Time Entry
1. Check database:
```sql
SELECT * FROM user_billing_rates WHERE user_id = '<your-user-id>';
SELECT hourly_rate_usd FROM time_entries LIMIT 5;
```

**Expected Result:**
- Time entries use rate from effective date
- Rate frozen at time of entry creation

---

### G. Edge Cases & Error Handling

#### ✅ Test 20: Timer Auto-Recovery
1. Start timer
2. Wait 2 minutes
3. Kill browser tab (don't close gracefully)
4. Reopen app

**Expected Result:**
- Timer resumes from where it left off
- Elapsed time continues

#### ✅ Test 21: Stale Timer Cleanup
1. Check database:
```sql
SELECT * FROM active_timers WHERE last_ping_at < NOW() - INTERVAL '24 hours';
```
2. Call cleanup function:
```sql
SELECT cleanup_stale_timers();
```

**Expected Result:**
- Old timers (>24h without ping) deleted

#### ✅ Test 22: Cannot Edit Invoiced Entry
1. Try to edit a time entry with status = 'invoiced'

**Expected Result:**
- Error: "Cannot update time entry with status: invoiced"
- Edit/Delete buttons hidden

#### ✅ Test 23: Cannot Delete Submitted Entry
1. Try to delete submitted entry

**Expected Result:**
- Error: "Cannot delete time entry with status: submitted"
- Delete button hidden

#### ✅ Test 24: Invoice Totals Recalculation
1. Generate invoice with 3 entries
2. Manually add line item via modal
3. Check totals

**Expected Result:**
- Subtotal updates
- Tax recalculates
- Total = subtotal + tax (trigger runs automatically)

#### ✅ Test 25: Void Invoice
1. Generate and send invoice
2. Click **Void** button
3. Confirm

**Expected Result:**
- Status: Void (gray)
- Time entries status back to: Approved
- `invoice_id` removed from time entries
- Can be re-invoiced

---

### H. UI/UX Verification

#### ✅ Test 26: Stats Cards Update
1. Note stats on Time Entries page
2. Create 2 new entries
3. Submit 1 entry
4. Approve 1 entry

**Expected Result:**
- Total hours increases
- Draft count +2, then +1
- Approved count +1
- Total value recalculates

#### ✅ Test 27: Filters Work
1. On Time Entries page, set filters:
   - Status: Approved
   - Date From: 7 days ago
   - Date To: Today
2. Click search

**Expected Result:**
- Only approved entries in date range shown
- Clear filters resets all

#### ✅ Test 28: Timer Widget States
1. Minimize widget (click X)
2. Check bottom-right corner

**Expected Result:**
- Circular button with Clock icon
- Badge shows timer count
- Click to expand

#### ✅ Test 29: Mobile Responsive
1. Resize browser to mobile width (375px)
2. Check all pages

**Expected Result:**
- Forms stack vertically
- Tables scroll horizontally
- Widget stays in corner
- All buttons accessible

#### ✅ Test 30: Loading States
1. Throttle network to "Slow 3G" (DevTools)
2. Generate invoice

**Expected Result:**
- Spinner shown while loading
- Button disabled
- "Generating..." or spinner icon
- No double-submit possible

---

## Performance Tests

### ✅ Test 31: Large Dataset
1. Create 100 time entries via script:
```javascript
// In browser console
for (let i = 0; i < 100; i++) {
  fetch('/api/time/entries', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer <token>' },
    body: JSON.stringify({
      matter_id: '<matter-id>',
      duration_minutes: Math.floor(Math.random() * 480),
      description: `Test entry ${i}`,
      billable: true
    })
  });
}
```

**Expected Result:**
- List renders in < 500ms
- Pagination works
- No UI lag

### ✅ Test 32: Concurrent Timers
1. Start 5 timers simultaneously
2. Let run for 5 minutes
3. Check database pings

**Expected Result:**
- All timers ping every 60s
- No missing pings
- No conflicts in database

---

## Database Integrity Tests

### ✅ Test 33: Audit Trail
1. Check audit log:
```sql
SELECT * FROM audit_log
WHERE resource_type IN ('time_entry', 'invoice', 'timer')
ORDER BY created_at DESC
LIMIT 20;
```

**Expected Result:**
- All CRUD operations logged
- User ID captured
- Action types: create, update, delete, submit, approve, etc.

### ✅ Test 34: Validate Audit Chain
```sql
SELECT * FROM validate_audit_chain();
```

**Expected Result:**
- `is_valid`: true
- Chain integrity maintained

### ✅ Test 35: Invoice Totals Consistency
```sql
SELECT
  id,
  invoice_number,
  subtotal_usd,
  tax_amount_usd,
  total_usd,
  (subtotal_usd + tax_amount_usd) as calculated_total,
  (subtotal_usd + tax_amount_usd = total_usd) as totals_match
FROM matter_invoices;
```

**Expected Result:**
- All `totals_match` = true

---

## Security Tests

### ✅ Test 36: JWT Authentication
1. Logout
2. Try to access `/api/time/entries` directly

**Expected Result:**
- 401 Unauthorized
- Error: "User not authenticated"

### ✅ Test 37: Rate Limiting
1. Make 100 rapid requests to `/api/time/entries`

**Expected Result:**
- No 429 errors (rate limit not configured for time entries)
- All requests succeed or fail gracefully

---

## Summary Report Template

After completing all tests, fill this out:

```
PHASE 1 TEST RESULTS
====================

Date: ___________
Tester: ___________

BACKEND (15 tests)
✅ Migration applied successfully
✅ TimeEntryService operational
✅ MatterInvoiceService operational
✅ PDF generation works
✅ All API endpoints respond
✅ Audit logging captures events
✅ Database constraints enforced
✅ Triggers fire correctly
✅ Functions return expected results
✅ JWT authentication works
✅ Timer ping mechanism functional
✅ Stale timer cleanup works
✅ Invoice totals auto-calculate
✅ Payment status updates
✅ Void invoice unlinks entries

FRONTEND (22 tests)
✅ Time Entries page loads
✅ Create time entry form works
✅ Timer widget appears
✅ Multi-timer support works
✅ Timer persistence across refresh
✅ Submit/Approve workflow functions
✅ Invoices page loads
✅ Generate invoice modal works
✅ Invoice detail modal displays
✅ PDF download triggers
✅ Payment recording form works
✅ Stats cards update correctly
✅ Filters function properly
✅ Loading states shown
✅ Error handling displays messages
✅ Forms validate input
✅ Modal close/cancel works
✅ Responsive design adapts
✅ Navigation links work
✅ Sidebar integration complete
✅ TimeTrackerWidget responsive
✅ Real-time updates occur

CRITICAL ISSUES: ___________
MINOR ISSUES: ___________
NOTES: ___________
```

---

## Quick Smoke Test (5 minutes)

If you only have 5 minutes, test this flow:

1. ✅ Start timer for a matter → Widget appears
2. ✅ Wait 1 minute → Timer increments
3. ✅ Stop timer → Entry created
4. ✅ Submit entry → Status = Submitted
5. ✅ Approve entry → Status = Approved
6. ✅ Generate invoice → Invoice created
7. ✅ Download PDF → PDF downloads
8. ✅ Record payment → Status = Paid

If all 8 steps pass, core functionality is working!
