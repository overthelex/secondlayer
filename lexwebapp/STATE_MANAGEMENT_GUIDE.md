# State Management Guide

## Overview

Phase 4 introduces modern state management using **React Query** for server state and **Zustand** for client state. This separation provides optimal performance, caching, and developer experience.

## Architecture

```
src/
├── lib/
│   └── react-query.ts          # React Query configuration
├── providers/
│   └── QueryProvider.tsx       # React Query provider
├── hooks/
│   └── queries/                # React Query hooks
│       ├── useLegal.ts
│       ├── useAuth.ts
│       ├── useBilling.ts
│       ├── useClients.ts
│       └── index.ts
└── stores/                     # Zustand stores
    ├── chatStore.ts
    ├── uiStore.ts
    ├── settingsStore.ts
    └── index.ts
```

## Why Two State Management Libraries?

### React Query (Server State)
**Use for:**
- API calls and responses
- Cached data from backend
- Automatic refetching
- Optimistic updates
- Loading/error states

**Examples:**
- User profile
- Balance and transactions
- Client list
- Legal advice responses

### Zustand (Client State)
**Use for:**
- UI state (sidebar, modals)
- User preferences
- Chat messages (ephemeral)
- Application settings

**Examples:**
- Sidebar open/closed
- Theme preference
- Chat history
- Form data

## React Query Usage

### 1. Query Hooks (GET operations)

#### Basic Query
```tsx
import { useBalance } from '../hooks/queries';

function BalanceWidget() {
  const { data, isLoading, error, refetch } = useBalance();

  if (isLoading) return <Spinner />;
  if (error) return <Error message={error.message} />;

  return (
    <div>
      <h2>Balance: ${data.amount_usd}</h2>
      <button onClick={() => refetch()}>Refresh</button>
    </div>
  );
}
```

#### Query with Parameters
```tsx
import { useTransactionHistory } from '../hooks/queries';

function TransactionList() {
  const { data, isLoading } = useTransactionHistory({
    limit: 20,
    type: 'deposit',
  });

  return (
    <ul>
      {data?.transactions.map(tx => (
        <li key={tx.id}>{tx.description}</li>
      ))}
    </ul>
  );
}
```

#### Conditional Query (only fetch when needed)
```tsx
import { useClient } from '../hooks/queries';

function ClientProfile({ clientId }: { clientId?: string }) {
  // Only fetches if clientId exists
  const { data } = useClient(clientId);

  if (!clientId) return null;
  if (!data) return <Spinner />;

  return <div>{data.name}</div>;
}
```

### 2. Mutation Hooks (POST/PUT/DELETE operations)

#### Basic Mutation
```tsx
import { useCreateClient } from '../hooks/queries';
import showToast from '../utils/toast';

function CreateClientForm() {
  const { mutate, isPending } = useCreateClient();

  const handleSubmit = (data) => {
    mutate(data, {
      onSuccess: (newClient) => {
        showToast.success('Client created!');
        navigate(`/clients/${newClient.id}`);
      },
      onError: (error) => {
        showToast.error(error.message);
      },
    });
  };

  return (
    <form onSubmit={handleSubmit}>
      {/* form fields */}
      <button type="submit" disabled={isPending}>
        {isPending ? 'Creating...' : 'Create'}
      </button>
    </form>
  );
}
```

#### Async Mutation (await result)
```tsx
import { useGetLegalAdvice } from '../hooks/queries';

function ChatPage() {
  const { mutateAsync: getLegalAdvice } = useGetLegalAdvice();

  const handleSend = async (query: string) => {
    try {
      const result = await getLegalAdvice({ query });
      addMessage(result);
    } catch (error) {
      showToast.error(error.message);
    }
  };

  return <ChatInput onSend={handleSend} />;
}
```

#### Mutation with Optimistic Update
```tsx
import { useUpdateProfile } from '../hooks/queries';

function ProfileForm() {
  const { mutate } = useUpdateProfile();

  const handleUpdate = (data) => {
    mutate(data);
    // UI updates immediately (optimistic)
    // Rolls back on error automatically
  };

  return <form onSubmit={handleUpdate}>...</form>;
}
```

### 3. Automatic Features

#### Auto Refetch
```tsx
// Balance refreshes every 5 minutes automatically
const { data } = useBalance();
// Defined in hook: refetchInterval: 5 * 60 * 1000
```

#### Stale Time (cache duration)
```tsx
// User data fresh for 10 minutes
const { data } = useUser();
// Defined in hook: staleTime: 10 * 60 * 1000
```

#### Retry on Error
```tsx
// Automatically retries failed requests
// Configured globally in lib/react-query.ts
retry: (failureCount, error) => {
  if (error?.status >= 400 && error?.status < 500) {
    return false; // Don't retry 4xx errors
  }
  return failureCount < 2; // Retry up to 2 times
}
```

### 4. Query Invalidation

```tsx
import { useQueryClient } from '@tanstack/react-query';
import { queryKeys } from '../lib/react-query';

function SomeComponent() {
  const queryClient = useQueryClient();

  const refreshBalance = () => {
    // Invalidate and refetch balance
    queryClient.invalidateQueries({ queryKey: queryKeys.billing.balance });
  };

  const refreshAllBilling = () => {
    // Invalidate all billing queries
    queryClient.invalidateQueries({ queryKey: queryKeys.billing.all });
  };

  return <button onClick={refreshBalance}>Refresh</button>;
}
```

## Zustand Usage

### 1. Chat Store

```tsx
import { useChatStore } from '../stores';

function ChatPage() {
  // Select only what you need (prevents unnecessary re-renders)
  const messages = useChatStore((state) => state.messages);
  const isStreaming = useChatStore((state) => state.isStreaming);
  const addMessage = useChatStore((state) => state.addMessage);

  // Or destructure multiple values
  const { messages, addMessage, clearMessages } = useChatStore();

  const handleSend = (content: string) => {
    addMessage({
      id: Date.now().toString(),
      role: 'user',
      content,
    });
  };

  return (
    <>
      <Messages messages={messages} />
      <button onClick={clearMessages}>Clear</button>
    </>
  );
}
```

### 2. UI Store

```tsx
import { useUIStore } from '../stores';

function Header() {
  const { isSidebarOpen, toggleSidebar } = useUIStore();

  return (
    <button onClick={toggleSidebar}>
      {isSidebarOpen ? 'Close' : 'Open'} Sidebar
    </button>
  );
}

function ModalExample() {
  const { openModal, closeModal, isModalOpen } = useUIStore();

  const showModal = () => openModal('confirm-delete');
  const hideModal = () => closeModal('confirm-delete');

  return (
    <>
      <button onClick={showModal}>Delete</button>
      {isModalOpen('confirm-delete') && (
        <Modal onClose={hideModal}>...</Modal>
      )}
    </>
  );
}
```

### 3. Settings Store

```tsx
import { useSettingsStore } from '../stores';

function SettingsPage() {
  const {
    maxPrecedents,
    showThinkingSteps,
    setMaxPrecedents,
    setShowThinkingSteps,
  } = useSettingsStore();

  return (
    <div>
      <label>
        Max Precedents: {maxPrecedents}
        <input
          type="range"
          min="1"
          max="10"
          value={maxPrecedents}
          onChange={(e) => setMaxPrecedents(Number(e.target.value))}
        />
      </label>

      <label>
        <input
          type="checkbox"
          checked={showThinkingSteps}
          onChange={(e) => setShowThinkingSteps(e.target.checked)}
        />
        Show Thinking Steps
      </label>
    </div>
  );
}
```

### 4. Persistent Storage

Zustand stores automatically persist to localStorage:

```tsx
// chatStore persists: messages, currentSessionId
// uiStore persists: sidebar state, theme
// settingsStore persists: all settings
```

Access outside React:
```tsx
import { useChatStore } from '../stores';

// Outside component
const messages = useChatStore.getState().messages;
useChatStore.getState().addMessage(newMessage);
```

## Benefits

### 🚀 Performance

#### Before (local state)
```tsx
const [messages, setMessages] = useState([]);
const [isLoading, setIsLoading] = useState(false);
const [balance, setBalance] = useState(null);
const [transactions, setTransactions] = useState([]);

// Every state change triggers re-render
// No caching - refetch on every mount
// Manual loading/error states
```

#### After (React Query + Zustand)
```tsx
const { data: balance } = useBalance(); // Cached, auto-refetch
const { data: transactions } = useTransactionHistory(); // Separate cache
const { messages, addMessage } = useChatStore(); // Only re-render when messages change

// Automatic caching
// Automatic refetching
// Automatic loading/error states
// Optimistic updates
```

### 📦 Automatic Caching

```tsx
// First render: Fetches from API
const { data } = useBalance();

// Component unmounts and remounts within 5 minutes
// Second render: Returns cached data instantly
const { data } = useBalance();

// After 5 minutes (staleTime)
// Refetches automatically in background
```

### 🔄 Automatic Refetching

```tsx
// Refetch on window focus
const { data } = useTransactionHistory();
// User switches tabs and returns
// → Automatically refetches to ensure fresh data

// Refetch on reconnect
// User loses and regains internet connection
// → Automatically refetches
```

### ⚡ Optimistic Updates

```tsx
const { mutate } = useUpdateProfile();

// UI updates immediately
mutate({ name: 'New Name' });
// → User sees change instantly
// → If server fails, rolls back automatically
```

### 🎯 Selective Re-renders

```tsx
// ❌ Bad: Re-renders on any state change
const state = useChatStore();

// ✅ Good: Only re-renders when messages change
const messages = useChatStore((state) => state.messages);
```

## React Query DevTools

Development-only tools for debugging queries:

```tsx
// Automatically included in development mode
// Access at bottom-right corner of screen

Features:
- View all queries and their states
- See cache data
- Manually refetch queries
- Inspect query keys
- Monitor loading/error states
```

## Common Patterns

### Pattern 1: Load and Display Data
```tsx
function ClientList() {
  const { data, isLoading, error } = useClients();

  if (isLoading) return <Spinner />;
  if (error) return <Error message={error.message} />;
  if (!data?.items.length) return <EmptyState />;

  return (
    <ul>
      {data.items.map(client => (
        <li key={client.id}>{client.name}</li>
      ))}
    </ul>
  );
}
```

### Pattern 2: Create and Redirect
```tsx
function CreateForm() {
  const navigate = useNavigate();
  const { mutate, isPending } = useCreateClient();

  const handleSubmit = (data) => {
    mutate(data, {
      onSuccess: (newClient) => {
        navigate(`/clients/${newClient.id}`);
      },
    });
  };

  return <form onSubmit={handleSubmit} />;
}
```

### Pattern 3: Combined Server + Client State
```tsx
function ChatPage() {
  // Server state (React Query)
  const { mutateAsync: getLegalAdvice } = useGetLegalAdvice();

  // Client state (Zustand)
  const { messages, addMessage, isStreaming, setStreaming } = useChatStore();
  const { maxPrecedents } = useSettingsStore();

  const handleSend = async (content: string) => {
    setStreaming(true);
    addMessage({ role: 'user', content });

    const response = await getLegalAdvice({
      query: content,
      max_precedents: maxPrecedents,
    });

    addMessage(response);
    setStreaming(false);
  };

  return <Chat messages={messages} onSend={handleSend} />;
}
```

### Pattern 4: Dependent Queries
```tsx
function ClientTransactions({ clientId }: { clientId: string }) {
  // First query
  const { data: client } = useClient(clientId);

  // Second query depends on first
  const { data: transactions } = useTransactionHistory({
    client_id: clientId,
  });

  return (
    <div>
      <h1>{client?.name}</h1>
      <TransactionList transactions={transactions} />
    </div>
  );
}
```

## Migration Guide

### Before (Local State)
```tsx
function OldComponent() {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    setLoading(true);
    api.getData()
      .then(setData)
      .catch(setError)
      .finally(() => setLoading(false));
  }, []);

  if (loading) return <Spinner />;
  if (error) return <Error />;
  return <Display data={data} />;
}
```

### After (React Query)
```tsx
function NewComponent() {
  const { data, isLoading, error } = useGetData();

  if (isLoading) return <Spinner />;
  if (error) return <Error />;
  return <Display data={data} />;
}

// In hooks/queries/useData.ts
export function useGetData() {
  return useQuery({
    queryKey: ['data'],
    queryFn: () => api.getData(),
  });
}
```

## Best Practices

### 1. Use Query Keys Factory
```tsx
// ✅ Good: Centralized query keys
import { queryKeys } from '../lib/react-query';
const { data } = useQuery({
  queryKey: queryKeys.clients.list({ status: 'active' }),
  queryFn: () => clientService.getClients({ status: 'active' }),
});

// ❌ Bad: Hardcoded query keys
const { data } = useQuery({
  queryKey: ['clients', 'active'],
  queryFn: () => clientService.getClients({ status: 'active' }),
});
```

### 2. Selective Subscriptions in Zustand
```tsx
// ✅ Good: Only subscribe to what you need
const messages = useChatStore((state) => state.messages);
const addMessage = useChatStore((state) => state.addMessage);

// ❌ Bad: Subscribe to entire store
const store = useChatStore();
```

### 3. Handle Loading and Error States
```tsx
// ✅ Good: Handle all states
const { data, isLoading, error } = useBalance();
if (isLoading) return <Spinner />;
if (error) return <Error message={error.message} />;
return <Display data={data} />;

// ❌ Bad: Assume data exists
const { data } = useBalance();
return <Display data={data} />; // Can crash if data is undefined
```

### 4. Use Mutations for Side Effects
```tsx
// ✅ Good: Use mutation
const { mutate } = useCreateClient();
mutate(data, {
  onSuccess: () => refetch(),
});

// ❌ Bad: Direct API call
const handleCreate = async (data) => {
  await api.createClient(data);
  refetch(); // Manual refetch
};
```

## Summary

Phase 4 State Management provides:
- ✅ Automatic caching
- ✅ Optimistic updates
- ✅ Loading/error states
- ✅ Auto refetching
- ✅ Persistent storage
- ✅ DevTools
- ✅ Type safety
- ✅ Better performance

**Result:** Cleaner code, better UX, improved performance!
