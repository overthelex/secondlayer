# UI Kit Guide

## Overview

Phase 5 introduces a comprehensive UI Component Library - a reusable design system with consistent styling, variants, and accessibility features.

## Components

### 🎨 Design Tokens

Centralized design system constants in `constants/design-tokens.ts`:

```tsx
import { colors, spacing, typography, shadows } from '../constants/design-tokens';

// Colors
colors.primary[500]  // #0ea5e9
colors.claude.accent // #0ea5e9
colors.success.DEFAULT // #10b981

// Spacing (8px scale)
spacing[4] // 1rem (16px)
spacing[8] // 2rem (32px)

// Typography
typography.fontSize.lg // 1.125rem
typography.fontWeight.semibold // 600

// Shadows
shadows.md // Professional shadow
shadows.lg // Elevated shadow
```

## Components Library

### 1. Button

**Features:**
- 5 variants (primary, secondary, outline, ghost, danger)
- 3 sizes (sm, md, lg)
- Loading state with spinner
- Icon support (left/right)
- Full width option
- Disabled state

**Usage:**
```tsx
import { Button } from '../components/ui';
import { Save, Trash2 } from 'lucide-react';

// Basic
<Button variant="primary">Click Me</Button>

// With loading
<Button isLoading>Saving...</Button>

// With icons
<Button leftIcon={<Save size={16} />}>Save</Button>
<Button rightIcon={<Trash2 size={16} />} variant="danger">
  Delete
</Button>

// Sizes
<Button size="sm">Small</Button>
<Button size="md">Medium</Button>
<Button size="lg">Large</Button>

// Variants
<Button variant="primary">Primary</Button>
<Button variant="secondary">Secondary</Button>
<Button variant="outline">Outline</Button>
<Button variant="ghost">Ghost</Button>
<Button variant="danger">Danger</Button>

// Full width
<Button fullWidth>Full Width Button</Button>
```

### 2. Input

**Features:**
- 3 sizes (sm, md, lg)
- 3 variants (default, filled, flushed)
- Label and helper text
- Error state with message
- Icon support (left/right)
- Full width option

**Usage:**
```tsx
import { Input } from '../components/ui';
import { Search, Mail } from 'lucide-react';

// Basic
<Input placeholder="Enter text" />

// With label
<Input label="Email" type="email" placeholder="you@example.com" />

// With helper text
<Input
  label="Password"
  type="password"
  helperText="Must be at least 8 characters"
/>

// With error
<Input
  label="Username"
  error="This username is already taken"
/>

// With icons
<Input
  leftIcon={<Search size={18} />}
  placeholder="Search..."
/>

<Input
  rightIcon={<Mail size={18} />}
  type="email"
/>

// Variants
<Input variant="default" placeholder="Default" />
<Input variant="filled" placeholder="Filled" />
<Input variant="flushed" placeholder="Flushed" />

// Sizes
<Input size="sm" placeholder="Small" />
<Input size="md" placeholder="Medium" />
<Input size="lg" placeholder="Large" />
```

### 3. Card

**Features:**
- 3 variants (default, outlined, elevated)
- Composition (Card, CardHeader, CardBody, CardFooter)
- Hoverable effect
- Flexible content

**Usage:**
```tsx
import { Card, CardHeader, CardBody, CardFooter } from '../components/ui';

// Basic
<Card>
  <CardBody>
    Content here
  </CardBody>
</Card>

// With all sections
<Card variant="elevated">
  <CardHeader>
    <h2 className="text-xl font-semibold">Card Title</h2>
  </CardHeader>
  <CardBody>
    <p>Card content goes here...</p>
  </CardBody>
  <CardFooter>
    <Button>Action</Button>
  </CardFooter>
</Card>

// Variants
<Card variant="default">Default Card</Card>
<Card variant="outlined">Outlined Card</Card>
<Card variant="elevated">Elevated Card</Card>

// Hoverable
<Card hoverable onClick={() => console.log('Clicked')}>
  <CardBody>Click me!</CardBody>
</Card>
```

### 4. Modal

**Features:**
- 5 sizes (sm, md, lg, xl, full)
- Animated entrance/exit
- Backdrop click to close
- Escape key to close
- Body scroll lock
- Accessible (focus trap)
- Close button

**Usage:**
```tsx
import { Modal, Button, Input } from '../components/ui';
import { useState } from 'react';

function MyComponent() {
  const [isOpen, setIsOpen] = useState(false);

  return (
    <>
      <Button onClick={() => setIsOpen(true)}>
        Open Modal
      </Button>

      <Modal
        isOpen={isOpen}
        onClose={() => setIsOpen(false)}
        title="My Modal"
        size="md"
      >
        <div className="space-y-4">
          <p>Modal content here</p>
          <Input label="Name" />
          <Button fullWidth>Submit</Button>
        </div>
      </Modal>
    </>
  );
}

// Sizes
<Modal size="sm">Small modal</Modal>
<Modal size="md">Medium modal</Modal>
<Modal size="lg">Large modal</Modal>
<Modal size="xl">Extra large modal</Modal>
<Modal size="full">Full screen modal</Modal>

// Without title or close button
<Modal
  isOpen={isOpen}
  onClose={() => setIsOpen(false)}
  showCloseButton={false}
>
  Custom modal
</Modal>

// Prevent backdrop close
<Modal
  isOpen={isOpen}
  onClose={() => setIsOpen(false)}
  closeOnBackdrop={false}
>
  Must click close button
</Modal>
```

### 5. Badge

**Features:**
- 5 variants (default, success, error, warning, info)
- 3 sizes (sm, md, lg)
- Dot indicator
- Flexible content

**Usage:**
```tsx
import { Badge } from '../components/ui';

// Basic
<Badge>Default</Badge>

// Variants
<Badge variant="success">Success</Badge>
<Badge variant="error">Error</Badge>
<Badge variant="warning">Warning</Badge>
<Badge variant="info">Info</Badge>

// Sizes
<Badge size="sm">Small</Badge>
<Badge size="md">Medium</Badge>
<Badge size="lg">Large</Badge>

// With dot
<Badge dot variant="success">Active</Badge>
<Badge dot variant="error">Offline</Badge>

// Custom usage
<div className="flex items-center gap-2">
  <span>Status:</span>
  <Badge variant="success" dot>Online</Badge>
</div>
```

### 6. Checkbox

**Features:**
- Custom styled checkbox
- Label support
- Error state
- Accessible
- Smooth animation

**Usage:**
```tsx
import { Checkbox } from '../components/ui';
import { useState } from 'react';

function MyComponent() {
  const [checked, setChecked] = useState(false);

  return (
    <>
      {/* Basic */}
      <Checkbox
        label="Accept terms and conditions"
        checked={checked}
        onChange={(e) => setChecked(e.target.checked)}
      />

      {/* Without label */}
      <Checkbox checked={checked} onChange={...} />

      {/* With error */}
      <Checkbox
        label="Required field"
        error="You must accept"
      />

      {/* Disabled */}
      <Checkbox label="Disabled" disabled />
    </>
  );
}
```

### 7. Switch

**Features:**
- Toggle switch
- 3 sizes (sm, md, lg)
- Label support
- Smooth animation
- Accessible

**Usage:**
```tsx
import { Switch } from '../components/ui';
import { useState } from 'react';

function MyComponent() {
  const [enabled, setEnabled] = useState(false);

  return (
    <>
      {/* Basic */}
      <Switch
        label="Enable notifications"
        checked={enabled}
        onChange={(e) => setEnabled(e.target.checked)}
      />

      {/* Sizes */}
      <Switch size="sm" label="Small" />
      <Switch size="md" label="Medium" />
      <Switch size="lg" label="Large" />

      {/* Without label */}
      <Switch checked={enabled} onChange={...} />

      {/* Disabled */}
      <Switch label="Disabled" disabled />
    </>
  );
}
```

### 8. Spinner

**Features:**
- 4 sizes (sm, md, lg, xl)
- 3 colors (primary, white, gray)
- Animated rotation

**Usage:**
```tsx
import { Spinner } from '../components/ui';

// Basic
<Spinner />

// Sizes
<Spinner size="sm" />
<Spinner size="md" />
<Spinner size="lg" />
<Spinner size="xl" />

// Colors
<Spinner color="primary" />
<Spinner color="white" />
<Spinner color="gray" />

// In button
<Button>
  <Spinner size="sm" color="white" />
  Loading...
</Button>

// Centered
<div className="flex items-center justify-center h-64">
  <Spinner size="xl" />
</div>
```

## Composition Patterns

### Form with Validation
```tsx
import { Card, CardBody, Input, Button, Checkbox } from '../components/ui';
import { useState } from 'react';

function SignupForm() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [errors, setErrors] = useState({});
  const [accepted, setAccepted] = useState(false);

  const handleSubmit = (e) => {
    e.preventDefault();
    // Validation logic
  };

  return (
    <Card variant="elevated">
      <CardBody>
        <form onSubmit={handleSubmit} className="space-y-4">
          <Input
            label="Email"
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            error={errors.email}
          />

          <Input
            label="Password"
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            error={errors.password}
          />

          <Checkbox
            label="I accept the terms and conditions"
            checked={accepted}
            onChange={(e) => setAccepted(e.target.checked)}
          />

          <Button type="submit" fullWidth>
            Sign Up
          </Button>
        </form>
      </CardBody>
    </Card>
  );
}
```

### Confirmation Modal
```tsx
import { Modal, Button } from '../components/ui';

function ConfirmModal({ isOpen, onClose, onConfirm, title, message }) {
  const [isDeleting, setIsDeleting] = useState(false);

  const handleConfirm = async () => {
    setIsDeleting(true);
    await onConfirm();
    setIsDeleting(false);
    onClose();
  };

  return (
    <Modal isOpen={isOpen} onClose={onClose} title={title} size="sm">
      <div className="space-y-4">
        <p className="text-gray-600">{message}</p>

        <div className="flex gap-2 justify-end">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="danger"
            isLoading={isDeleting}
            onClick={handleConfirm}
          >
            Confirm
          </Button>
        </div>
      </div>
    </Modal>
  );
}
```

### Status Dashboard
```tsx
import { Card, CardHeader, CardBody, Badge, Button } from '../components/ui';

function StatusDashboard() {
  return (
    <div className="grid grid-cols-3 gap-4">
      <Card variant="elevated" hoverable>
        <CardHeader>
          <div className="flex items-center justify-between">
            <h3>Server Status</h3>
            <Badge variant="success" dot>Online</Badge>
          </div>
        </CardHeader>
        <CardBody>
          <p className="text-2xl font-bold">99.9%</p>
          <p className="text-sm text-gray-500">Uptime</p>
        </CardBody>
      </Card>

      <Card variant="elevated" hoverable>
        <CardHeader>
          <div className="flex items-center justify-between">
            <h3>API Status</h3>
            <Badge variant="warning" dot>Degraded</Badge>
          </div>
        </CardHeader>
        <CardBody>
          <p className="text-2xl font-bold">523ms</p>
          <p className="text-sm text-gray-500">Response time</p>
        </CardBody>
      </Card>

      <Card variant="elevated" hoverable>
        <CardHeader>
          <div className="flex items-center justify-between">
            <h3>Database</h3>
            <Badge variant="error" dot>Offline</Badge>
          </div>
        </CardHeader>
        <CardBody>
          <p className="text-2xl font-bold">0</p>
          <p className="text-sm text-gray-500">Connections</p>
        </CardBody>
      </Card>
    </div>
  );
}
```

## Accessibility

All components follow WCAG 2.1 guidelines:

- ✅ **Keyboard navigation** - All interactive elements
- ✅ **Focus indicators** - Visible focus rings
- ✅ **Screen reader support** - Proper ARIA labels
- ✅ **Color contrast** - WCAG AA compliant
- ✅ **Focus trap** - Modal keeps focus inside
- ✅ **Escape key** - Closes modals/dialogs

## Theming

### Custom Colors
```tsx
// Update tailwind.config.js or use CSS variables
<Button className="bg-purple-500 hover:bg-purple-600">
  Custom Color
</Button>
```

### Dark Mode (Future)
```tsx
// Components are dark-mode ready
<Card className="dark:bg-gray-800 dark:text-white">
  Content
</Card>
```

## Best Practices

### 1. Import from index
```tsx
// ✅ Good
import { Button, Input, Card } from '../components/ui';

// ❌ Bad
import { Button } from '../components/ui/Button/Button';
```

### 2. Use variants consistently
```tsx
// ✅ Good - Primary actions use primary variant
<Button variant="primary">Save</Button>
<Button variant="danger">Delete</Button>

// ❌ Bad - Inconsistent use
<Button variant="outline">Save</Button>
```

### 3. Provide labels for inputs
```tsx
// ✅ Good - Accessible
<Input label="Email" type="email" />

// ❌ Bad - Missing label
<Input type="email" />
```

### 4. Handle loading states
```tsx
// ✅ Good - Clear feedback
<Button isLoading={isSubmitting}>Submit</Button>

// ❌ Bad - No feedback
<Button disabled={isSubmitting}>Submit</Button>
```

## Migration Example

### Before (Hardcoded styles)
```tsx
function OldComponent() {
  return (
    <div className="bg-white p-6 rounded-lg shadow-md">
      <h2 className="text-xl font-semibold mb-4">Title</h2>
      <input
        type="text"
        className="w-full px-4 py-2 border rounded-lg focus:outline-none focus:ring-2"
      />
      <button className="mt-4 px-4 py-2 bg-blue-500 text-white rounded-lg hover:bg-blue-600">
        Submit
      </button>
    </div>
  );
}
```

### After (UI Kit)
```tsx
import { Card, CardHeader, CardBody, Input, Button } from '../components/ui';

function NewComponent() {
  return (
    <Card variant="elevated">
      <CardHeader>
        <h2 className="text-xl font-semibold">Title</h2>
      </CardHeader>
      <CardBody className="space-y-4">
        <Input fullWidth />
        <Button fullWidth>Submit</Button>
      </CardBody>
    </Card>
  );
}
```

**Benefits:**
- ✅ Consistent styling
- ✅ Less code
- ✅ Reusable
- ✅ Accessible
- ✅ Type-safe

## Component Showcase

See `components/examples/UIKitExample.tsx` for a complete showcase of all components with interactive examples.

## Summary

Phase 5 UI Kit provides:
- ✅ 8 reusable components
- ✅ Design tokens system
- ✅ Consistent styling
- ✅ Accessibility built-in
- ✅ TypeScript types
- ✅ Variants and sizes
- ✅ Animations
- ✅ Composition patterns

**Result:** Professional, consistent, accessible UI with less code!
