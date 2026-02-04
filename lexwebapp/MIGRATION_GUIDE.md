# Migration Guide: From ChatLayout to Router-Based Architecture

## Quick Start

### For Developers

If you're working with the code after this refactoring, here's what changed:

#### 1. Navigation

**OLD WAY (removed):**
```tsx
setCurrentView('judges');
setSelectedPerson(person);
```

**NEW WAY:**
```tsx
import { useNavigate } from 'react-router-dom';
import { ROUTES, generateRoute } from '../router/routes';

const navigate = useNavigate();
navigate(ROUTES.JUDGES);
navigate(generateRoute.judgeDetail(person.id), { state: { person } });
```

#### 2. Adding New Pages

**Step 1:** Create page component
```tsx
// src/pages/NewFeaturePage/index.tsx
import { useNavigate } from 'react-router-dom';

export function NewFeaturePage() {
  const navigate = useNavigate();

  return (
    <div>
      <button onClick={() => navigate(-1)}>Back</button>
      {/* Your content */}
    </div>
  );
}
```

**Step 2:** Add route constant
```tsx
// src/router/routes.ts
export const ROUTES = {
  // ... existing routes
  NEW_FEATURE: '/new-feature',
};
```

**Step 3:** Register in router
```tsx
// src/router/index.tsx
import { NewFeaturePage } from '../pages/NewFeaturePage';

// In router children array:
{
  path: ROUTES.NEW_FEATURE,
  element: <NewFeaturePage />,
}
```

**Step 4:** Add to sidebar (if needed)
```tsx
// src/layouts/MainLayout.tsx
<Sidebar
  // ... existing props
  onNewFeatureClick={() => navigate(ROUTES.NEW_FEATURE)}
/>
```

#### 3. Converting Existing Components with `onBack`

If your component has `onBack?: () => void` prop:

**Before:**
```tsx
export function MyPage({ onBack }: { onBack?: () => void }) {
  return (
    <button onClick={onBack}>Back</button>
  );
}
```

**After:**
```tsx
import { useBackNavigation } from '../hooks/useBackNavigation';

export function MyPage({ onBack }: { onBack?: () => void }) {
  const handleBack = useBackNavigation(onBack);

  return (
    <button onClick={handleBack}>Back</button>
  );
}
```

This makes `onBack` optional - if not provided, it uses browser history.

#### 4. Accessing Route Parameters

```tsx
import { useParams, useLocation } from 'react-router-dom';

function PersonDetailPage() {
  // Get URL params
  const { id } = useParams<{ id: string }>();

  // Get navigation state
  const location = useLocation();
  const person = location.state?.person;

  return <div>Person ID: {id}</div>;
}
```

#### 5. Protected Routes

All routes under `<AuthGuard />` require authentication. The guard:
- Shows loading spinner while checking auth
- Redirects to `/login` if not authenticated
- Renders child routes if authenticated

To add new protected route:
```tsx
// Already done - all routes in MainLayout are protected
// Just add your route to router/index.tsx children array
```

## Components Status

### ✅ Migrated to Router
- App.tsx
- MainLayout (new)
- ChatPage (new)
- JudgesPage (wrapper)
- LawyersPage (wrapper)
- ClientsPage (wrapper)
- PersonDetailPage (wrapper)
- ClientDetailPage (wrapper)
- ClientMessagingPage (wrapper)
- BillingDashboard
- CaseAnalysisPage

### ⏳ Ready to Migrate (have onBack but still direct components)
These components work with current setup but could benefit from migration:
- LegislationMonitoringPage
- CourtPracticeAnalysisPage
- LegalInitiativesPage
- LegislationStatisticsPage
- VotingAnalysisPage
- LegalCodesLibraryPage
- HistoricalAnalysisPage

**To migrate:** Add `useBackNavigation` hook (see section 3 above)

### 🆕 New Components
- **MainLayout**: Replaces ChatLayout for layout structure
- **ChatPage**: Contains only chat-specific logic
- **Page Wrappers**: Handle routing state and navigation

## Common Patterns

### Pattern 1: List → Detail Navigation

```tsx
// List page
function JudgesPage() {
  const navigate = useNavigate();

  const handleSelectJudge = (judge) => {
    navigate(
      generateRoute.judgeDetail(judge.id),
      { state: { judge } }
    );
  };

  return <JudgesList onSelect={handleSelectJudge} />;
}

// Detail page
function PersonDetailPage() {
  const { id } = useParams();
  const location = useLocation();
  const navigate = useNavigate();

  const person = location.state?.person;

  if (!person) {
    // Fetch by ID or show error
    return <div>Loading...</div>;
  }

  return (
    <>
      <button onClick={() => navigate(-1)}>Back</button>
      <PersonDetails person={person} />
    </>
  );
}
```

### Pattern 2: Form → Success Navigation

```tsx
function CreateClientPage() {
  const navigate = useNavigate();

  const handleSubmit = async (data) => {
    const client = await api.createClient(data);
    navigate(
      generateRoute.clientDetail(client.id),
      { state: { client, message: 'Client created!' } }
    );
  };

  return <ClientForm onSubmit={handleSubmit} />;
}
```

### Pattern 3: Modal → Navigation

```tsx
function ClientsPage() {
  const navigate = useNavigate();
  const [showModal, setShowModal] = useState(false);

  const handleSendMessage = (clientIds) => {
    navigate(ROUTES.CLIENT_MESSAGING, {
      state: { clientIds }
    });
  };

  return (
    <>
      <ClientsList />
      {showModal && (
        <Modal onConfirm={handleSendMessage} />
      )}
    </>
  );
}
```

## Troubleshooting

### Issue: "useNavigate() may be used only in the context of a <Router> component"

**Solution:** Make sure your component is rendered within the router:
- Check that it's in `router/index.tsx` children
- Ensure `<RouterProvider>` is in App.tsx

### Issue: State is lost on page refresh

**Solution:** Route state is ephemeral. For persistent data:
```tsx
// Option 1: Fetch data based on URL param
const { id } = useParams();
const { data } = useQuery(['person', id], () => api.getPerson(id));

// Option 2: Use local/session storage
sessionStorage.setItem('person', JSON.stringify(person));

// Option 3: Use state management (Zustand/Redux)
const person = usePersonStore((state) => state.currentPerson);
```

### Issue: Back button doesn't work as expected

**Solution:** Use `navigate(-1)` for browser back, or `navigate(ROUTES.SPECIFIC)` for explicit navigation:
```tsx
const handleBack = () => {
  // Go to previous page
  navigate(-1);

  // OR go to specific page
  navigate(ROUTES.CLIENTS);
};
```

## Testing

### Manual Testing Checklist

- [ ] Login redirects to `/chat`
- [ ] All sidebar links navigate correctly
- [ ] Back button works on each page
- [ ] URL updates on navigation
- [ ] Browser back/forward work
- [ ] Refresh preserves authentication
- [ ] Deep links work (e.g., `/judges/123`)
- [ ] Logout redirects to `/login`

### Build Test

```bash
npm run build
# Should complete without errors
```

### Dev Server Test

```bash
npm run dev
# Navigate to: http://localhost:5173
# Test all routes
```

## Future Improvements

### Phase 2: State Management
- Install Zustand or Redux Toolkit
- Move API calls to services
- Implement React Query for server state

### Phase 3: Code Splitting
```tsx
// router/index.tsx
const ChatPage = lazy(() => import('../pages/ChatPage'));

{
  path: ROUTES.CHAT,
  element: (
    <Suspense fallback={<Loading />}>
      <ChatPage />
    </Suspense>
  ),
}
```

### Phase 4: Route Prefetching
```tsx
import { useEffect } from 'react';
import { router } from '../router';

// Prefetch likely next pages
useEffect(() => {
  router.preload(ROUTES.JUDGES);
}, []);
```

## Resources

- [React Router Docs](https://reactrouter.com/)
- [ROUTES constants](./src/router/routes.ts)
- [Router config](./src/router/index.tsx)
- [Refactoring summary](./REFACTORING_SUMMARY.md)

## Questions?

Check:
1. `REFACTORING_SUMMARY.md` for architecture overview
2. `src/router/routes.ts` for available routes
3. `src/pages/` for implementation examples
4. Existing page wrappers for patterns

## Migration Priority

**High Priority:**
1. ✅ Core navigation (completed)
2. ✅ Authentication flow (completed)
3. ⏳ State management (next phase)

**Medium Priority:**
4. ⏳ Service layer for API calls
5. ⏳ UI component library
6. ⏳ Error boundaries

**Low Priority:**
7. Code splitting
8. Route prefetching
9. Advanced caching
