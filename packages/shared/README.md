# @secondlayer/shared

Shared utilities and components for SecondLayer MCP servers (mcp_backend and mcp_rada).

## Overview

This package contains common code extracted from `mcp_backend` and `mcp_rada` to eliminate duplication and improve maintainability.

## Features

### 🔧 Utilities

#### Logger
Winston-based logging with configurable service names.

```typescript
import { createLogger, type Logger } from '@secondlayer/shared';

const logger: Logger = createLogger('my-service');
logger.info('Service started');
```

#### LLM Clients
Unified interface for OpenAI and Anthropic with automatic retry, rate limiting, and cost tracking.

```typescript
import { 
  getLLMManager, 
  type UnifiedChatRequest 
} from '@secondlayer/shared';

const llm = getLLMManager();

const response = await llm.chatCompletion({
  messages: [
    { role: 'system', content: 'You are a helpful assistant' },
    { role: 'user', content: 'Hello!' }
  ]
}, 'standard'); // budget: 'quick' | 'standard' | 'deep'
```

#### Model Selector
Smart model selection based on reasoning budget and task complexity.

```typescript
import { ModelSelector } from '@secondlayer/shared';

const selection = ModelSelector.getModelSelection('deep');
// { provider: 'openai', model: 'gpt-4o', budget: 'deep' }

const cost = ModelSelector.estimateCostAccurate('gpt-4o', 1000, 500);
// Accurate cost calculation based on actual token counts
```

### 🗄️ Database

Base database class with PostgreSQL connection pooling, transactions, and error handling.

```typescript
import { BaseDatabase, type DatabaseConfig } from '@secondlayer/shared';

class MyDatabase extends BaseDatabase {
  constructor() {
    const config: DatabaseConfig = {
      host: process.env.POSTGRES_HOST || 'localhost',
      port: parseInt(process.env.POSTGRES_PORT || '5432'),
      user: process.env.POSTGRES_USER || 'myuser',
      password: process.env.POSTGRES_PASSWORD || 'mypassword',
      database: process.env.POSTGRES_DB || 'mydb',
      schema: process.env.POSTGRES_SCHEMA, // optional
    };
    super(config);
  }
}

const db = new MyDatabase();
await db.connect();

// Query
const result = await db.query('SELECT * FROM users WHERE id = $1', [userId]);

// Transaction
await db.transaction(async (client) => {
  await client.query('INSERT INTO users (name) VALUES ($1)', ['John']);
  await client.query('INSERT INTO profiles (user_id) VALUES ($1)', [userId]);
});
```

### 🌐 HTTP

#### SSE Handler
Server-Sent Events utilities for streaming responses.

```typescript
import { SSEHandler } from '@secondlayer/shared';

app.post('/stream', (req, res) => {
  SSEHandler.setupHeaders(res);
  SSEHandler.sendConnected(res, 'my-tool');
  
  SSEHandler.sendProgress(res, 'Processing...', 0.5);
  
  // ... do work ...
  
  SSEHandler.sendComplete(res, { result: 'done' });
  SSEHandler.sendEnd(res);
});
```

## Installation

This package is used locally via file reference:

```json
{
  "dependencies": {
    "@secondlayer/shared": "file:../packages/shared"
  }
}
```

## Development

```bash
# Install dependencies
npm install

# Build
npm run build

# Watch mode
npm run dev
```

## Architecture

```
packages/shared/
├── src/
│   ├── utils/
│   │   ├── logger.ts              # Winston logger factory
│   │   ├── openai-client.ts       # OpenAI client manager
│   │   ├── anthropic-client.ts    # Anthropic client manager
│   │   ├── llm-client-manager.ts  # Unified LLM interface
│   │   └── model-selector.ts      # Model selection strategy
│   ├── database/
│   │   └── base-database.ts       # PostgreSQL base class
│   ├── http/
│   │   └── sse-handler.ts         # SSE utilities
│   └── index.ts                   # Main exports
├── dist/                          # Compiled output
└── package.json
```

## Refactoring Impact

### Code Reduction

| Component | Before | After | Savings |
|-----------|--------|-------|---------|
| Logger | 44 lines | 34 lines | 23% |
| OpenAI Client | 324 lines | 176 lines | 46% |
| Anthropic Client | 306 lines | 161 lines | 47% |
| LLM Manager | 474 lines | 251 lines | 47% |
| Model Selector | 564 lines | 294 lines | 48% |
| Database | 148 lines | 145 lines | 2% |
| **Total** | **1,860 lines** | **1,061 lines** | **43%** |

### Benefits

- ✅ **Single source of truth** for common utilities
- ✅ **Easier maintenance** - fix once, apply everywhere
- ✅ **Consistent behavior** across services
- ✅ **Type safety** with TypeScript
- ✅ **Better testability** - test shared code once

## Environment Variables

### LLM Configuration

```bash
# OpenAI
OPENAI_API_KEY=sk-...
OPENAI_API_KEY2=sk-...  # Optional fallback key

# Anthropic
ANTHROPIC_API_KEY=sk-ant-...
ANTHROPIC_API_KEY2=sk-ant-...  # Optional fallback key

# Model selection
LLM_PROVIDER_STRATEGY=openai-first  # or 'anthropic-first'
OPENAI_MODEL_QUICK=gpt-4o-mini
OPENAI_MODEL_STANDARD=gpt-4o-mini
OPENAI_MODEL_DEEP=gpt-4o
ANTHROPIC_MODEL_QUICK=claude-haiku-4.5
ANTHROPIC_MODEL_STANDARD=claude-sonnet-4.5
ANTHROPIC_MODEL_DEEP=claude-opus-4.5

# Logging
LOG_LEVEL=info  # debug | info | warn | error
```

### Database Configuration

```bash
POSTGRES_HOST=localhost
POSTGRES_PORT=5432
POSTGRES_USER=myuser
POSTGRES_PASSWORD=mypassword
POSTGRES_DB=mydb
POSTGRES_SCHEMA=public  # Optional
```

## License

MIT
