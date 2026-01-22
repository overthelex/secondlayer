# SecondLayer Token Distribution Mockups

This directory contains HTML/CSS mockups for a token distribution and payment system for the SecondLayer legal analysis platform.

## Overview

A complete set of static HTML mockups demonstrating a modern, minimalistic token payment and subscription system. The design follows patterns from leading LLM providers (OpenAI, Anthropic) with a clean, professional aesthetic.

## Design System

### Color Palette

- **Primary Blue**: `#0066FF` - Main accent color for CTAs and highlights
- **Monochrome Base**: Grays, white, and black for all other elements
- **Status Colors**:
  - Success: `#00CC66` (Green)
  - Warning: `#FFB020` (Amber)
  - Error: `#FF3B3B` (Red)

### Typography

- **Font Family**: System fonts (SF Pro Display, Segoe UI, Roboto)
- **Font Sizes**: 12px to 48px scale
- **Font Weights**: 400 (normal), 500 (medium), 600 (semibold), 700 (bold)

### Spacing

Consistent 8px-based spacing scale:
- xs: 4px
- sm: 8px
- md: 16px
- lg: 24px
- xl: 32px
- 2xl: 48px
- 3xl: 64px

## File Structure

```
buytoken/
├── index.html              # Landing page with payment options
├── profile.html            # User profile and settings
├── balance.html            # Balance display and top-up
├── billing.html            # Subscription plans and billing
├── invoices.html           # Invoice history with filters
├── usage.html              # Usage analytics dashboard
├── css/
│   ├── main.css           # Core styles (layout, typography, utilities)
│   └── components.css     # Reusable components (cards, buttons, tables)
├── assets/
│   ├── icons/             # Heroicons SVG files (inline in HTML)
│   └── images/            # Placeholder for logos
└── README.md              # This file
```

## Pages

### 1. `index.html` - Payment Landing Page

**Purpose**: Initial entry point for users to sign up and select payment method

**Features**:
- Google OAuth2 login button (mockup)
- Three payment method cards:
  - Monobank QR Code
  - VISA/Mastercard
  - MetaMask Wallet
- 3-tier subscription plan preview (Starter, Pro, Enterprise)
- Clean hero section with value proposition

**Design Notes**: No sidebar, uses full-width centered layout

---

### 2. `profile.html` - User Profile Page

**Purpose**: Manage user account information and connected payment methods

**Features**:
- Sidebar navigation (persistent across app pages)
- Profile header with avatar and account status badge
- Editable profile information (name, email, registration date)
- Connected payment methods display:
  - Monobank QR (Connected badge)
  - VISA •••• 1234 (Default badge)
  - MetaMask wallet address
- Security settings:
  - Password change
  - Two-factor authentication toggle
- Danger zone (delete account)

**Key Components**: Sidebar, cards, badges, form inputs

---

### 3. `balance.html` - Balance & Top-Up

**Purpose**: View current token balance and add funds

**Features**:
- Large balance display card (gradient background, white text)
  - Shows tokens available and USD equivalent
- Quick top-up buttons ($10, $20, $50, $100)
- Custom amount input with payment method selector
- Balance history chart (mockup - CSS-only bar chart)
- Transaction history table (last 10 transactions)
  - Shows top-ups, usage, and subscriptions
  - Status badges (Completed, Pending, Usage)

**Key Components**: Stats display, quick-action buttons, table, chart placeholder

---

### 4. `billing.html` - Subscription & Billing

**Purpose**: Manage subscription plans and billing preferences

**Features**:
- Current subscription card (highlighted with blue border)
  - Shows plan name, next billing date, monthly cost
  - Cancel subscription option
- 3-tier pricing cards:
  - **Starter**: $10/month, 100K tokens
  - **Pro**: $50/month, 500K tokens (Current Plan badge)
  - **Enterprise**: Custom pricing, unlimited tokens
- Billing settings:
  - Auto-reload toggle (auto-add funds when balance is low)
  - Default payment method selector

**Key Components**: Pricing cards, feature lists with checkmarks, toggles

---

### 5. `invoices.html` - Invoice History

**Purpose**: View and download past invoices

**Features**:
- Filter controls:
  - Date range (Last 30 days, 90 days, 6 months, year, all time)
  - Status (All, Paid, Pending, Failed, Refunded)
  - Payment method (All, VISA, Monobank, MetaMask)
- Invoice table with columns:
  - Invoice # (clickable links)
  - Date
  - Description (Top-up, Subscription, etc.)
  - Amount
  - Payment Method
  - Status badge
  - Download icon
- Pagination controls (10 invoices per page)
- Export All button (top-right)

**Key Components**: Filter bar, data table, pagination, download icons

---

### 6. `usage.html` - Usage Analytics

**Purpose**: Track token consumption and API usage

**Features**:
- 4 summary stat cards:
  - Tokens used this month (with % change)
  - Tokens remaining (% of limit)
  - Average daily usage
  - Most active day
- Usage chart (line chart with gradient fill - SVG mockup)
  - Time period selector (7 days, 30 days, 90 days, 12 months)
- Detailed usage breakdown table:
  - Timestamp
  - Feature/Endpoint name (with API path)
  - Tokens consumed
  - Cost in USD
  - Status

**Key Components**: Stat cards, line chart (SVG), detailed table

---

## Payment Methods (Mockups)

### Monobank QR Code
- **Visual**: QR code icon
- **Description**: "Scan QR code with Monobank app"
- **Implementation Note**: Would integrate with Monobank Acquiring API
- **API Docs**: https://monobank.ua/api-docs/acquiring

### VISA/Mastercard
- **Visual**: Credit card icon
- **Description**: "Pay with VISA or Mastercard"
- **Implementation Note**: Card payments processed through Monobank payment link

### MetaMask Wallet
- **Visual**: Wallet icon
- **Description**: "Connect your crypto wallet"
- **Implementation Note**: Would use MetaMask browser extension API for Web3 integration

### Google OAuth2
- **Visual**: Google logo button
- **Description**: "Continue with Google"
- **Implementation Note**: Uses Google OAuth2 for authentication (email only)

---

## Subscription Plans

| Plan | Price | Tokens/Month | Features |
|------|-------|--------------|----------|
| **Starter** | $10/month | 100K | Basic support, Community access, Email support, 48h response |
| **Pro** | $50/month | 500K | Priority support, Advanced features, API access, 12h response, Analytics |
| **Enterprise** | Custom | Unlimited | Dedicated support, Custom integration, SLA, On-premise, Account manager |

---

## CSS Architecture

### `main.css`

**Purpose**: Foundation styles and layout system

**Contents**:
- CSS custom properties (color palette, spacing, typography)
- Reset and base styles
- Typography hierarchy (h1-h6, p, a, code)
- Layout components (container, page-layout, sidebar)
- Header and navigation
- Grid system (1-4 columns)
- Flex utilities
- Spacing utilities
- Text utilities
- Responsive breakpoints

### `components.css`

**Purpose**: Reusable UI components

**Contents**:
- **Cards**: Standard card, card-header, card-body, card-footer, card-highlight
- **Buttons**: Primary, secondary, outline, ghost, success, danger (with size variants)
- **Badges**: Success, warning, error, info, neutral
- **Forms**: Inputs, selects, textareas, checkboxes, radios, labels, hints, errors
- **Tables**: Standard table, striped, compact variants
- **Stats Cards**: Stat label, value, change indicator
- **Payment Cards**: Clickable payment method cards with icons
- **Pricing Cards**: Subscription pricing with feature lists
- **QR Display**: QR code container with label and amount
- **Alerts**: Info, success, warning, error alerts
- **Empty State**: Placeholder for no data
- **Pagination**: Page navigation controls
- **Divider**: Horizontal rule and text divider
- **Spinner**: Loading indicator

---

## Icons

All icons are from **Heroicons v2** (outline style) and are embedded inline as SVG in the HTML files.

**Common Icons Used**:
- User (profile)
- Wallet (balance)
- Credit Card (billing, payments)
- Document (invoices)
- Chart Bar (usage analytics)
- QR Code (Monobank payment)
- Check Circle (success states)
- Exclamation Circle (warnings)
- Download (invoice downloads)
- Arrow Down (pagination, downloads)

**Note**: For brand logos (Google, MetaMask), inline SVG logos are used directly in HTML.

---

## Responsive Design

### Breakpoints

- **Mobile**: < 480px
- **Tablet**: 481px - 768px
- **Desktop**: > 768px

### Mobile Adaptations

- Sidebar hidden on mobile (< 768px)
- Grid columns collapse to single column
- Font sizes scale down slightly
- Header simplifies
- Tables scroll horizontally if needed

---

## Usage

### Opening the Mockups

1. Navigate to the `buytoken/` directory
2. Open any HTML file in a web browser:
   ```bash
   open index.html
   # or
   open profile.html
   ```

### Testing Navigation

- Click sidebar links to navigate between pages
- All internal links use relative paths (`href="profile.html"`)
- External links are placeholder anchors (`href="#"`)

### Viewing in Development Server

For better cross-origin behavior (if needed):

```bash
# Using Python 3
cd buytoken
python3 -m http.server 8000

# Using Node.js (if http-server installed)
npx http-server -p 8000

# Using PHP
php -S localhost:8000
```

Then open: http://localhost:8000/index.html

---

## Implementation Notes

### Non-Functional Elements

The following elements are **visual mockups only** and have no backend functionality:

- ✗ Google OAuth2 login (no actual authentication)
- ✗ Payment processing (buttons do nothing)
- ✗ QR code generation (placeholder image/icon only)
- ✗ MetaMask wallet connection (no Web3.js integration)
- ✗ Form submissions (no API endpoints)
- ✗ Data persistence (no database)
- ✗ Chart rendering (static SVG/CSS mockups)
- ✗ File downloads (invoice PDFs)
- ✗ Search and filtering (dropdowns are non-functional)

### Mockup Data

All displayed data is hardcoded placeholder content:
- User: "John Doe" (john.doe@example.com)
- Balance: 75,240 tokens
- Subscription: Pro plan ($50/month)
- Payment methods: VISA •••• 1234, Monobank, MetaMask
- Invoices and transactions: Sample data

---

## Future Implementation

To convert these mockups to a functional application, you would need:

1. **Backend API**:
   - User authentication (OAuth2, JWT)
   - Payment processing integration (Monobank Acquiring API, Stripe, etc.)
   - Subscription management
   - Token balance tracking
   - Usage analytics logging

2. **Frontend Framework** (optional):
   - React, Vue, or vanilla JS for interactivity
   - State management (Redux, Vuex, or Context API)
   - Form validation
   - API client for backend communication

3. **Database**:
   - User accounts
   - Payment methods
   - Transactions
   - Invoices
   - Usage logs

4. **Payment Integrations**:
   - **Monobank Acquiring API** for QR and card payments
   - **MetaMask/Web3.js** for crypto wallet integration
   - **Google OAuth2** for authentication

5. **Chart Library** (for real charts):
   - Chart.js, Recharts, or D3.js for usage analytics

---

## Design Inspirations

This mockup draws design patterns from:

- **OpenAI Platform**: Settings pages, API key management
- **Anthropic Console**: Usage analytics, token tracking
- **Stripe Dashboard**: Invoice tables, payment methods, billing
- **Vercel Dashboard**: Minimalist design, blue accent on monochrome

---

## Browser Compatibility

These mockups use modern CSS features and should work in:

- ✓ Chrome 90+
- ✓ Firefox 88+
- ✓ Safari 14+
- ✓ Edge 90+

**Not tested in Internet Explorer** (unsupported).

---

## Accessibility

Basic accessibility features included:

- ✓ Semantic HTML (header, nav, main, aside, section)
- ✓ Proper heading hierarchy (h1, h2, h3)
- ✓ Form labels associated with inputs
- ✓ Color contrast ratios meet WCAG AA standards (mostly)
- ✓ Focus states on interactive elements

**Not included** (would need in production):
- ✗ ARIA labels for complex components
- ✗ Keyboard navigation testing
- ✗ Screen reader testing

---

## License

These mockups are part of the SecondLayer project. All rights reserved.

---

## Contact

For questions about these mockups or the SecondLayer project, contact the development team.

---

**Last Updated**: January 18, 2024
