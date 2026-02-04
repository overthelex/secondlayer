# SecondLayer Billing GUI Mockups

Interactive HTML wireframes for the SecondLayer billing system. These mockups demonstrate the complete user experience for subscription management, usage tracking, and payment handling.

## 📁 Files Overview

### Main Pages

1. **index.html** - Navigation hub to all mockups
2. **01-dashboard.html** - Billing dashboard with current plan overview
3. **02-plans.html** - Plan selection and comparison
4. **03-usage.html** - Detailed usage statistics and analytics
5. **04-payment.html** - Payment methods and billing history
6. **05-limits.html** - Usage limits, alerts, and overage settings
7. **06-team.html** - Team management (Business/Enterprise only)

## 🚀 How to View

### Option 1: Direct Browser Open
```bash
# Open the index page in your browser
open docs/billing-mockups/index.html

# Or navigate to the full path
firefox /home/vovkes/SecondLayer/docs/billing-mockups/index.html
```

### Option 2: Local Web Server
```bash
cd docs/billing-mockups
python3 -m http.server 8000
# Then visit http://localhost:8000
```

## 🎨 Features Demonstrated

### 01-dashboard.html
- Current plan status card with next billing date
- Usage summary cards (queries, cost, API calls, tokens)
- 30-day usage trend chart
- Top 5 most-used tools with progress bars
- Quick actions (upgrade, add card, download report)
- Alert banner for quota warnings

### 02-plans.html
- 4 pricing tiers: Free, Professional, Business, Enterprise
- Monthly/Annual billing toggle with discount badge
- Feature comparison table with 10+ criteria
- Current plan highlighting
- Upgrade/downgrade buttons with prorated pricing info
- FAQ section

### 03-usage.html
- Time period selector (7/30/90 days, year)
- 4 summary metric cards with trend indicators
- Interactive usage over time chart
- Cost breakdown pie chart (by service)
- Top tools bar chart
- Detailed usage table per tool with:
  - Call counts
  - Average execution time
  - Token usage
  - Cost per tool
  - Percentage of total
- Cost optimization recommendations

### 04-payment.html
- Payment method cards (Visa, Mastercard)
- Primary card designation
- Add new payment method prompt
- Auto-pay toggle with next charge info
- Billing information form (company, tax ID, address)
- Complete billing history table with:
  - Invoice numbers
  - Payment dates
  - Descriptions
  - Amounts
  - Status badges (Paid/Pending/Failed)
  - Download/retry actions
- Pagination

### 05-limits.html
- Current period usage card (queries used/remaining)
- Usage breakdown by category (search, analysis, legislation)
- Budget tracking (monthly limit vs actual)
- Cost breakdown by service type
- Alert configuration panel:
  - Email notifications (50%, 80%, 95%, 100%)
  - SMS alerts (Business+)
  - Webhook notifications
  - Slack integration
- Overage handling options:
  - Auto-upgrade
  - Pay-as-you-go
  - Hard stop
  - Soft cap
- Projected usage forecast

### 06-team.html
- Team overview cards (members, active users, queries, cost)
- Team members table with:
  - User profiles
  - Roles (Owner, Admin, User, Viewer)
  - Individual usage stats
  - Last activity
  - Status
  - Management actions
- Pending invitations
- Usage by user chart
- Cost distribution pie chart
- Roles & permissions matrix

## 💡 Design Highlights

### Technology Stack
- **Tailwind CSS** (via CDN) - Modern utility-first CSS framework
- **Chart.js** - Interactive charts and visualizations
- **Responsive Design** - Mobile-friendly layouts
- **Ukrainian Localization** - All text in Ukrainian

### Color Scheme
- **Primary Blue**: `#3B82F6` - CTAs and highlights
- **Success Green**: `#22C55E` - Positive indicators
- **Warning Yellow**: `#FBBF24` - Quota warnings
- **Danger Red**: `#EF4444` - Critical alerts
- **Purple**: `#A855F7` - Premium features

### UI Components
- Progress bars with color coding
- Status badges with semantic colors
- Interactive toggles for settings
- Card-based layouts
- Responsive tables with hover states
- Gradient backgrounds for premium sections

## 📊 Data Model Implied

### Key Database Tables
```sql
-- subscriptions
user_id, plan_id, status, current_period_start, current_period_end

-- usage_quotas
user_id, queries_limit, queries_used, reset_at

-- payment_methods
user_id, card_last4, card_type, is_primary

-- invoices
invoice_number, user_id, amount, status, created_at

-- team_members
team_id, user_id, role, status

-- usage_alerts
user_id, threshold, notification_type, enabled
```

## 🔧 Implementation Notes

### Next Steps for Development
1. Replace static data with API calls
2. Implement state management (Redux/Context)
3. Add form validation
4. Integrate payment gateway (LiqPay/Stripe)
5. Set up real-time usage updates (WebSockets/SSE)
6. Add export functionality (PDF/CSV)
7. Implement webhook management
8. Add email template previews

### API Endpoints Needed
```
GET  /api/billing/dashboard
GET  /api/billing/plans
POST /api/billing/subscribe
GET  /api/billing/usage
GET  /api/billing/payments
POST /api/billing/payment-method
GET  /api/billing/limits
POST /api/billing/alerts
GET  /api/team/members
POST /api/team/invite
```

## 🎯 User Flows Covered

1. **New User**: Free → View plans → Upgrade to Professional → Add payment method
2. **Usage Monitoring**: Dashboard → Check usage → Set alert at 80% → Configure auto-upgrade
3. **Billing Review**: Payments → Download invoice → Update billing info
4. **Team Setup**: Invite members → Assign roles → Track team usage
5. **Quota Management**: Check limits → See forecast → Purchase add-on or upgrade

## 📱 Responsive Breakpoints

- **Mobile**: < 768px (stacked layouts)
- **Tablet**: 768px - 1024px (2-column grids)
- **Desktop**: > 1024px (full 3-4 column layouts)

## 🌐 Browser Compatibility

Tested and working in:
- Chrome 90+
- Firefox 88+
- Safari 14+
- Edge 90+

## 📝 Notes

- All prices in Ukrainian hryvnia (₴)
- Dates in Ukrainian format (DD MONTH YYYY)
- Charts use Chart.js 3.x
- No backend dependencies - pure frontend mockups
- Tailwind CSS loaded via CDN for quick prototyping

---

**Created**: February 2026
**Framework**: Tailwind CSS + Chart.js
**Status**: Mockup/Wireframe (non-functional)
**Next**: Implement with React + Backend API
