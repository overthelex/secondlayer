# Service Layer Guide

## Overview

Service layer забезпечує централізоване управління API викликами, обробку помилок та трансформацію даних. Всі компоненти тепер використовують сервіси замість прямих API викликів.

## Architecture

```
src/
├── services/
│   ├── base/
│   │   └── BaseService.ts          # Abstract base class
│   ├── api/
│   │   ├── LegalService.ts         # Legal API operations
│   │   ├── AuthService.ts          # Authentication operations
│   │   ├── BillingService.ts       # Billing & payments
│   │   └── ClientService.ts        # Client management
│   └── index.ts                    # Service exports
└── types/
    ├── models/                     # Domain models
    │   ├── Message.ts
    │   ├── User.ts
    │   ├── Client.ts
    │   ├── Person.ts
    │   ├── Billing.ts
    │   └── index.ts
    └── api/                        # API types
        ├── requests.ts
        ├── responses.ts
        └── index.ts
```

## Benefits

### ✅ Separation of Concerns
- **Components**: UI logic only
- **Services**: API calls, data transformation
- **Types**: Strong typing across app

### ✅ Centralized Error Handling
```tsx
try {
  await legalService.getLegalAdvice(request);
} catch (error: ServiceError) {
  // Uniform error structure
  console.error(error.code, error.message);
}
```

### ✅ Easy Testing
```tsx
// Mock services in tests
jest.mock('../services', () => ({
  legalService: {
    getLegalAdvice: jest.fn(),
  },
}));
```

### ✅ Code Reusability
```tsx
// Use same service in multiple components
const advice = await legalService.getLegalAdvice({ query });
const cases = await legalService.searchCourtCases({ query });
```

## Usage Examples

### 1. Legal Service

```tsx
import { legalService } from '../services';

// Get legal advice
const handleSearch = async (query: string) => {
  try {
    const message = await legalService.getLegalAdvice({
      query,
      max_precedents: 5,
    });

    // message is fully typed as Message
    console.log(message.content);
    console.log(message.decisions);
  } catch (error: any) {
    console.error('Error:', error.message);
  }
};

// Search court cases
const searchCases = async (query: string) => {
  const results = await legalService.searchCourtCases({
    query,
    limit: 10,
  });
};
```

### 2. Auth Service

```tsx
import { authService } from '../services';

// Get user profile
const user = await authService.getMe();

// Update profile
const updated = await authService.updateProfile({
  name: 'New Name',
  picture: 'https://...',
});

// Refresh token
const newToken = await authService.refreshToken();

// Logout
await authService.logout();
```

### 3. Billing Service

```tsx
import { billingService } from '../services';

// Get balance
const balance = await billingService.getBalance();
console.log(`Balance: $${balance.amount_usd}`);

// Get transaction history
const { transactions, total } = await billingService.getTransactionHistory({
  limit: 20,
  offset: 0,
  type: 'deposit',
});

// Create payment
const payment = await billingService.createStripePayment(100);
window.location.href = payment.checkout_url;

// Update settings
await billingService.updateSettings({
  daily_limit_usd: 50,
  monthly_limit_usd: 500,
});
```

### 4. Client Service

```tsx
import { clientService } from '../services';

// Get all clients
const { items, total } = await clientService.getClients({
  query: 'search term',
  type: 'corporate',
  status: 'active',
});

// Get client by ID
const client = await clientService.getClientById('client-123');

// Create client
const newClient = await clientService.createClient({
  name: 'John Doe',
  company: 'ACME Corp',
  email: 'john@acme.com',
  phone: '+380...',
  type: 'corporate',
});

// Update client
await clientService.updateClient('client-123', {
  status: 'inactive',
});

// Send message
await clientService.sendMessage(
  ['client-1', 'client-2'],
  'Important message'
);
```

## Type Safety

### Request Types
```tsx
import { GetLegalAdviceRequest } from '../types/api';

const request: GetLegalAdviceRequest = {
  query: 'Що таке позовна давність?',
  max_precedents: 5,
  max_tokens: 1000,
  include_reasoning: true,
};
```

### Response Types
```tsx
import { GetLegalAdviceResponse } from '../types/api';

// Type-safe response handling
const handleResponse = (response: GetLegalAdviceResponse) => {
  console.log(response.answer);
  response.reasoning_chain?.forEach(step => {
    console.log(step.action, step.output);
  });
};
```

### Domain Models
```tsx
import { Message, User, Client } from '../types/models';

// Type-safe component props
interface ChatProps {
  messages: Message[];
  user: User;
}

// Type-safe state
const [clients, setClients] = useState<Client[]>([]);
```

## Error Handling

### Service Error Structure
```tsx
interface ServiceError {
  code: string;          // Error code (e.g., 'NETWORK_ERROR')
  message: string;       // Human-readable message
  status?: number;       // HTTP status code
  details?: any;         // Additional error details
}
```

### Handling Errors in Components
```tsx
import showToast from '../utils/toast';

const handleAction = async () => {
  try {
    await legalService.getLegalAdvice({ query });
  } catch (error: any) {
    // Show toast notification
    showToast.error(error.message);

    // Log for debugging
    console.error('Service error:', error);

    // Handle specific errors
    if (error.status === 402) {
      navigate('/billing');
    }
  }
};
```

## Creating New Services

### 1. Extend BaseService

```tsx
import { BaseService } from '../base/BaseService';

export class MyNewService extends BaseService {
  async doSomething(param: string) {
    try {
      const response = await this.client.get(`/api/endpoint/${param}`);
      return response.data;
    } catch (error) {
      return this.handleError(error);
    }
  }
}

export const myNewService = new MyNewService();
```

### 2. Add Types

```tsx
// types/api/requests.ts
export interface DoSomethingRequest {
  param: string;
  options?: Record<string, any>;
}

// types/api/responses.ts
export interface DoSomethingResponse {
  result: string;
  metadata?: any;
}
```

### 3. Use in Components

```tsx
import { myNewService } from '../services';

const result = await myNewService.doSomething('value');
```

## Migration Guide

### Before (Direct API Call)
```tsx
const handleSend = async (query: string) => {
  try {
    const response = await fetch('/api/tools/get_legal_advice', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${API_KEY}`,
      },
      body: JSON.stringify({ query, max_precedents: 5 }),
    });

    const data = await response.json();

    // 80+ lines of parsing logic...
    let parsedResult: any = {};
    try {
      if (data.result?.content?.[0]?.text) {
        parsedResult = JSON.parse(data.result.content[0].text);
      }
    } catch (e) {
      console.warn('Failed to parse:', e);
    }

    // Transform to UI format...
    const message = {
      id: Date.now().toString(),
      role: 'assistant',
      content: parsedResult.summary || '...',
      // ... more transformation
    };
  } catch (error) {
    console.error('Error:', error);
  }
};
```

### After (Service Layer)
```tsx
import { legalService } from '../services';
import showToast from '../utils/toast';

const handleSend = async (query: string) => {
  try {
    // All parsing and transformation handled by service
    const message = await legalService.getLegalAdvice({
      query,
      max_precedents: 5,
    });

    // message is fully typed and ready to use
    setMessages(prev => [...prev, message]);
  } catch (error: any) {
    showToast.error(error.message);
  }
};
```

### Benefits of Migration
- ✅ 80+ lines → 10 lines
- ✅ Type-safe throughout
- ✅ Centralized error handling
- ✅ Reusable across components
- ✅ Easy to test and mock

## Best Practices

### 1. Always Use Services for API Calls
❌ **Bad:**
```tsx
const response = await fetch('/api/endpoint');
```

✅ **Good:**
```tsx
const data = await myService.getData();
```

### 2. Handle Errors Properly
❌ **Bad:**
```tsx
try {
  await service.call();
} catch (error) {
  console.log(error); // Silent failure
}
```

✅ **Good:**
```tsx
try {
  await service.call();
} catch (error: any) {
  showToast.error(error.message);
  console.error('Service error:', error);
}
```

### 3. Use Type Imports
❌ **Bad:**
```tsx
const request = { query: 'test', max_precedents: 5 };
```

✅ **Good:**
```tsx
import { GetLegalAdviceRequest } from '../types/api';

const request: GetLegalAdviceRequest = {
  query: 'test',
  max_precedents: 5,
};
```

### 4. Export Singleton Instances
```tsx
// service file
export class MyService extends BaseService {
  // ...
}

export const myService = new MyService();
```

```tsx
// usage
import { myService } from '../services';
```

## Testing Services

### Unit Test Example
```tsx
import { LegalService } from '../services';
import { Message } from '../types/models';

describe('LegalService', () => {
  let service: LegalService;

  beforeEach(() => {
    service = new LegalService();
  });

  it('should get legal advice', async () => {
    const message = await service.getLegalAdvice({
      query: 'test query',
    });

    expect(message).toBeDefined();
    expect(message.role).toBe('assistant');
    expect(message.content).toBeTruthy();
  });

  it('should handle errors', async () => {
    // Mock error
    jest.spyOn(global, 'fetch').mockRejectedValue(new Error('Network error'));

    await expect(
      service.getLegalAdvice({ query: 'test' })
    ).rejects.toThrow();
  });
});
```

### Integration Test Example
```tsx
import { render, screen, waitFor } from '@testing-library/react';
import { ChatPage } from './ChatPage';
import { legalService } from '../services';

jest.mock('../services');

test('sends message and displays response', async () => {
  const mockMessage = {
    id: '1',
    role: 'assistant',
    content: 'Test response',
  };

  (legalService.getLegalAdvice as jest.Mock).mockResolvedValue(mockMessage);

  render(<ChatPage />);

  // User types message
  const input = screen.getByRole('textbox');
  fireEvent.change(input, { target: { value: 'test query' } });
  fireEvent.submit(input);

  // Wait for response
  await waitFor(() => {
    expect(screen.getByText('Test response')).toBeInTheDocument();
  });
});
```

## Performance Considerations

### Singleton Pattern
Services use singleton pattern to avoid multiple instances:
```tsx
export const legalService = new LegalService();
```

### Request Deduplication
Consider adding request deduplication for identical concurrent requests:
```tsx
private pendingRequests = new Map<string, Promise<any>>();

async getData(key: string) {
  if (this.pendingRequests.has(key)) {
    return this.pendingRequests.get(key);
  }

  const promise = this.fetchData(key);
  this.pendingRequests.set(key, promise);

  try {
    return await promise;
  } finally {
    this.pendingRequests.delete(key);
  }
}
```

### Caching
Consider adding caching layer for frequently accessed data:
```tsx
private cache = new Map<string, { data: any; timestamp: number }>();

async getCachedData(key: string, ttl: number = 5000) {
  const cached = this.cache.get(key);
  if (cached && Date.now() - cached.timestamp < ttl) {
    return cached.data;
  }

  const data = await this.fetchData(key);
  this.cache.set(key, { data, timestamp: Date.now() });
  return data;
}
```

## Next Steps

### Phase 4: State Management with React Query
```tsx
import { useQuery, useMutation } from '@tanstack/react-query';
import { legalService } from '../services';

// Server state with caching
const { data, isLoading } = useQuery({
  queryKey: ['legal-advice', query],
  queryFn: () => legalService.getLegalAdvice({ query }),
});

// Mutations with optimistic updates
const mutation = useMutation({
  mutationFn: (data) => clientService.createClient(data),
  onSuccess: () => {
    queryClient.invalidateQueries(['clients']);
  },
});
```

### Phase 5: Advanced Features
- Request retry logic
- Request cancellation
- Batch requests
- WebSocket support
- Offline mode

## Summary

Service Layer provides:
- ✅ Centralized API logic
- ✅ Type safety
- ✅ Error handling
- ✅ Code reusability
- ✅ Testability
- ✅ Maintainability

All components now use services instead of direct API calls, making the codebase cleaner, more maintainable, and easier to test.
