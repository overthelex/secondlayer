/**
 * ConfigService
 * Manages runtime system configuration with DB override → env → default fallback
 */

import { Database } from '../database/database.js';
import { logger } from '../utils/logger.js';

export interface ConfigEntry {
  key: string;
  category: string;
  description: string;
  is_secret: boolean;
  value_type: 'string' | 'number' | 'boolean' | 'select';
  default_value: string;
  options?: string[];
}

export interface ConfigValue extends ConfigEntry {
  value: string;
  source: 'database' | 'env' | 'default';
  updated_at?: string;
  updated_by?: string;
}

const CONFIG_REGISTRY: ConfigEntry[] = [
  // AI Models
  { key: 'OPENAI_MODEL_QUICK', category: 'ai_models', description: 'Model for quick/cheap operations', is_secret: false, value_type: 'string', default_value: 'gpt-4o-mini' },
  { key: 'OPENAI_MODEL_STANDARD', category: 'ai_models', description: 'Model for standard operations', is_secret: false, value_type: 'string', default_value: 'gpt-4o-mini' },
  { key: 'OPENAI_MODEL_DEEP', category: 'ai_models', description: 'Model for deep analysis', is_secret: false, value_type: 'string', default_value: 'gpt-4o' },
  { key: 'OPENAI_EMBEDDING_MODEL', category: 'ai_models', description: 'Embedding model', is_secret: false, value_type: 'string', default_value: 'text-embedding-ada-002' },
  { key: 'OPENAI_MODEL', category: 'ai_models', description: 'Default OpenAI model', is_secret: false, value_type: 'string', default_value: 'gpt-4o' },
  { key: 'LLM_PROVIDER_STRATEGY', category: 'ai_models', description: 'Provider selection strategy', is_secret: false, value_type: 'select', default_value: 'round-robin', options: ['round-robin', 'openai-only', 'anthropic-only', 'failover'] },
  { key: 'ANTHROPIC_MODEL_QUICK', category: 'ai_models', description: 'Anthropic model for quick ops', is_secret: false, value_type: 'string', default_value: 'claude-haiku-4-5-20251001' },
  { key: 'ANTHROPIC_MODEL_STANDARD', category: 'ai_models', description: 'Anthropic model for standard ops', is_secret: false, value_type: 'string', default_value: 'claude-sonnet-4-6' },
  { key: 'ANTHROPIC_MODEL_DEEP', category: 'ai_models', description: 'Anthropic model for deep analysis', is_secret: false, value_type: 'string', default_value: 'claude-opus-4-6' },

  // Upload / Processing
  { key: 'MAX_CONCURRENT_PROCESSING', category: 'upload', description: 'Max concurrent upload processing jobs', is_secret: false, value_type: 'number', default_value: '50' },
  { key: 'MAX_USER_SESSIONS', category: 'upload', description: 'Max upload sessions per user', is_secret: false, value_type: 'number', default_value: '50' },
  { key: 'WORKERS_PER_CORE', category: 'upload', description: 'Processing workers per CPU core', is_secret: false, value_type: 'number', default_value: '2' },
  { key: 'MIN_CONCURRENT_PROCESSING', category: 'upload', description: 'Min concurrent processing jobs', is_secret: false, value_type: 'number', default_value: '5' },
  { key: 'ADAPTIVE_CONCURRENCY', category: 'upload', description: 'Enable adaptive concurrency', is_secret: false, value_type: 'boolean', default_value: 'true' },
  { key: 'MAX_BATCH_INIT_FILES', category: 'upload', description: 'Max files in batch init', is_secret: false, value_type: 'number', default_value: '50' },

  // Chat
  { key: 'MAX_CHAT_TOOL_CALLS', category: 'chat', description: 'Max tool calls per chat turn', is_secret: false, value_type: 'number', default_value: '5' },
  { key: 'CHAT_SEARCH_CACHE_TTL', category: 'chat', description: 'Chat search cache TTL (seconds)', is_secret: false, value_type: 'number', default_value: '300' },

  // Cache TTLs
  { key: 'CACHE_TTL_DEPUTIES', category: 'cache', description: 'Deputies cache TTL (seconds)', is_secret: false, value_type: 'number', default_value: '604800' },
  { key: 'CACHE_TTL_BILLS', category: 'cache', description: 'Bills cache TTL (seconds)', is_secret: false, value_type: 'number', default_value: '86400' },
  { key: 'CACHE_TTL_LAWS', category: 'cache', description: 'Laws cache TTL (seconds)', is_secret: false, value_type: 'number', default_value: '2592000' },
  { key: 'CACHE_TTL_VOTING', category: 'cache', description: 'Voting cache TTL (seconds)', is_secret: false, value_type: 'number', default_value: '86400' },

  // Scraping
  { key: 'SCRAPE_MAX_CONCURRENT', category: 'scraping', description: 'Max concurrent scrape jobs', is_secret: false, value_type: 'number', default_value: '10' },
  { key: 'SCRAPE_MIN_INTERVAL_MS', category: 'scraping', description: 'Min interval between scrapes (ms)', is_secret: false, value_type: 'number', default_value: '200' },
  { key: 'SCRAPE_MAX_QUEUE_DEPTH', category: 'scraping', description: 'Max scrape queue depth', is_secret: false, value_type: 'number', default_value: '200' },
  { key: 'SCRAPE_DELAY_MIN_MS', category: 'scraping', description: 'Min scrape delay (ms)', is_secret: false, value_type: 'number', default_value: '500' },
  { key: 'SCRAPE_DELAY_MAX_MS', category: 'scraping', description: 'Max scrape delay (ms)', is_secret: false, value_type: 'number', default_value: '2000' },

  // External APIs
  { key: 'ZAKONONLINE_MIN_REQUEST_INTERVAL_MS', category: 'external_apis', description: 'ZakonOnline min request interval (ms)', is_secret: false, value_type: 'number', default_value: '1000' },
  { key: 'ZAKONONLINE_RATE_LIMIT_DELAY_MS', category: 'external_apis', description: 'ZakonOnline rate limit delay (ms)', is_secret: false, value_type: 'number', default_value: '5000' },
  { key: 'ZAKONONLINE_TOKEN_STRATEGY', category: 'external_apis', description: 'ZakonOnline token strategy', is_secret: false, value_type: 'select', default_value: 'rotate', options: ['rotate', 'single', 'random'] },

  // Server
  { key: 'HTTP_PORT', category: 'server', description: 'HTTP server port', is_secret: false, value_type: 'number', default_value: '3000' },
  { key: 'HTTP_HOST', category: 'server', description: 'HTTP server host', is_secret: false, value_type: 'string', default_value: '0.0.0.0' },
  { key: 'NODE_ENV', category: 'server', description: 'Node environment', is_secret: false, value_type: 'select', default_value: 'development', options: ['development', 'production', 'test'] },
  { key: 'ALLOWED_ORIGINS', category: 'server', description: 'CORS allowed origins (comma-separated)', is_secret: false, value_type: 'string', default_value: '*' },
  { key: 'LOG_LEVEL', category: 'server', description: 'Logging level', is_secret: false, value_type: 'select', default_value: 'info', options: ['error', 'warn', 'info', 'debug', 'verbose'] },

  // Gateway
  { key: 'ENABLE_UNIFIED_GATEWAY', category: 'gateway', description: 'Enable unified gateway mode', is_secret: false, value_type: 'boolean', default_value: 'false' },
  { key: 'RADA_MCP_URL', category: 'gateway', description: 'RADA MCP service URL', is_secret: false, value_type: 'string', default_value: '' },
  { key: 'OPENREYESTR_MCP_URL', category: 'gateway', description: 'OpenReyestr MCP service URL', is_secret: false, value_type: 'string', default_value: '' },

  // Storage
  { key: 'MINIO_ENDPOINT', category: 'storage', description: 'MinIO endpoint', is_secret: false, value_type: 'string', default_value: 'localhost' },
  { key: 'MINIO_PORT', category: 'storage', description: 'MinIO port', is_secret: false, value_type: 'number', default_value: '9000' },
  { key: 'MINIO_USE_SSL', category: 'storage', description: 'MinIO use SSL', is_secret: false, value_type: 'boolean', default_value: 'false' },
  { key: 'QDRANT_URL', category: 'storage', description: 'Qdrant vector DB URL', is_secret: false, value_type: 'string', default_value: 'http://localhost:6333' },

  // Database
  { key: 'POSTGRES_HOST', category: 'database', description: 'PostgreSQL host', is_secret: false, value_type: 'string', default_value: 'localhost' },
  { key: 'POSTGRES_PORT', category: 'database', description: 'PostgreSQL port', is_secret: false, value_type: 'number', default_value: '5432' },
  { key: 'POSTGRES_DB', category: 'database', description: 'PostgreSQL database name', is_secret: false, value_type: 'string', default_value: 'secondlayer' },

  // Redis
  { key: 'REDIS_HOST', category: 'redis', description: 'Redis host', is_secret: false, value_type: 'string', default_value: 'localhost' },
  { key: 'REDIS_PORT', category: 'redis', description: 'Redis port', is_secret: false, value_type: 'number', default_value: '6379' },

  // Payments
  { key: 'MOCK_PAYMENTS', category: 'payments', description: 'Use mock payment providers', is_secret: false, value_type: 'boolean', default_value: 'true' },
  { key: 'UAH_TO_USD_RATE', category: 'payments', description: 'UAH to USD exchange rate', is_secret: false, value_type: 'number', default_value: '41.5' },
  { key: 'FONDY_API_URL', category: 'payments', description: 'Fondy API base URL', is_secret: false, value_type: 'string', default_value: 'https://pay.fondy.eu/api' },

  // Email
  { key: 'SMTP_HOST', category: 'email', description: 'SMTP server host', is_secret: false, value_type: 'string', default_value: '' },
  { key: 'SMTP_PORT', category: 'email', description: 'SMTP server port', is_secret: false, value_type: 'number', default_value: '587' },
  { key: 'SMTP_SECURE', category: 'email', description: 'SMTP use TLS', is_secret: false, value_type: 'boolean', default_value: 'false' },
  { key: 'EMAIL_FROM', category: 'email', description: 'From email address', is_secret: false, value_type: 'string', default_value: '' },
  { key: 'EMAIL_FROM_NAME', category: 'email', description: 'From display name', is_secret: false, value_type: 'string', default_value: 'SecondLayer' },

  // Auth
  { key: 'WEBAUTHN_RP_NAME', category: 'auth', description: 'WebAuthn relying party name', is_secret: false, value_type: 'string', default_value: 'SecondLayer' },
  { key: 'WEBAUTHN_RP_ID', category: 'auth', description: 'WebAuthn relying party ID', is_secret: false, value_type: 'string', default_value: 'localhost' },
  { key: 'WEBAUTHN_ORIGIN', category: 'auth', description: 'WebAuthn origin URL', is_secret: false, value_type: 'string', default_value: 'http://localhost:5173' },

  // Monitoring
  { key: 'PROMETHEUS_URL', category: 'monitoring', description: 'Prometheus server URL', is_secret: false, value_type: 'string', default_value: '' },

  // URLs
  { key: 'PUBLIC_URL', category: 'urls', description: 'Public-facing URL', is_secret: false, value_type: 'string', default_value: 'http://localhost:3000' },
  { key: 'FRONTEND_URL', category: 'urls', description: 'Frontend application URL', is_secret: false, value_type: 'string', default_value: 'http://localhost:5173' },
  { key: 'APP_URL', category: 'urls', description: 'Application URL', is_secret: false, value_type: 'string', default_value: 'http://localhost:5173' },

  // Secrets (read-only, masked)
  { key: 'OPENAI_API_KEY', category: 'ai_models', description: 'OpenAI API key', is_secret: true, value_type: 'string', default_value: '' },
  { key: 'ANTHROPIC_API_KEY', category: 'ai_models', description: 'Anthropic API key', is_secret: true, value_type: 'string', default_value: '' },
  { key: 'ZAKONONLINE_API_TOKEN', category: 'external_apis', description: 'ZakonOnline API token', is_secret: true, value_type: 'string', default_value: '' },
  { key: 'JWT_SECRET', category: 'auth', description: 'JWT signing secret', is_secret: true, value_type: 'string', default_value: '' },
  { key: 'POSTGRES_PASSWORD', category: 'database', description: 'PostgreSQL password', is_secret: true, value_type: 'string', default_value: '' },
  { key: 'SECONDARY_LAYER_KEYS', category: 'auth', description: 'API authentication keys', is_secret: true, value_type: 'string', default_value: '' },
  { key: 'MINIO_ACCESS_KEY', category: 'storage', description: 'MinIO access key', is_secret: true, value_type: 'string', default_value: '' },
  { key: 'MINIO_SECRET_KEY', category: 'storage', description: 'MinIO secret key', is_secret: true, value_type: 'string', default_value: '' },
  { key: 'STRIPE_SECRET_KEY', category: 'payments', description: 'Stripe secret key', is_secret: true, value_type: 'string', default_value: '' },
  { key: 'FONDY_SECRET_KEY', category: 'payments', description: 'Fondy secret key', is_secret: true, value_type: 'string', default_value: '' },
  { key: 'GOOGLE_CLIENT_SECRET', category: 'auth', description: 'Google OAuth client secret', is_secret: true, value_type: 'string', default_value: '' },
  { key: 'SMTP_PASS', category: 'email', description: 'SMTP password', is_secret: true, value_type: 'string', default_value: '' },
];

const CATEGORY_LABELS: Record<string, string> = {
  ai_models: 'AI Models',
  database: 'Database',
  redis: 'Redis',
  external_apis: 'External APIs',
  upload: 'Upload & Processing',
  chat: 'Chat',
  cache: 'Cache TTLs',
  scraping: 'Scraping',
  server: 'Server',
  gateway: 'Gateway',
  storage: 'Storage',
  payments: 'Payments',
  email: 'Email',
  auth: 'Authentication',
  monitoring: 'Monitoring',
  urls: 'URLs',
};

interface DbOverride {
  key: string;
  value: string;
  updated_at: string;
  updated_by: string | null;
}

export class ConfigService {
  private db: Database;
  private cache: Map<string, DbOverride> = new Map();
  private lastRefresh: number = 0;
  private refreshInterval: number = 60_000; // 60s

  constructor(db: Database) {
    this.db = db;
  }

  private async refreshCache(): Promise<void> {
    const now = Date.now();
    if (now - this.lastRefresh < this.refreshInterval) return;

    try {
      const result = await this.db.query(
        'SELECT key, value, updated_at, updated_by FROM system_config'
      );
      this.cache.clear();
      for (const row of result.rows) {
        this.cache.set(row.key, {
          key: row.key,
          value: row.value,
          updated_at: row.updated_at,
          updated_by: row.updated_by,
        });
      }
      this.lastRefresh = now;
    } catch (error: any) {
      logger.error('Failed to refresh config cache', { error: error.message });
    }
  }

  async get(key: string): Promise<string | undefined> {
    await this.refreshCache();
    const dbOverride = this.cache.get(key);
    if (dbOverride) return dbOverride.value;

    const envVal = process.env[key];
    if (envVal !== undefined) return envVal;

    const entry = CONFIG_REGISTRY.find(e => e.key === key);
    return entry?.default_value;
  }

  async getAll(): Promise<{ categories: Record<string, { label: string; entries: ConfigValue[] }> }> {
    await this.refreshCache();

    const categories: Record<string, { label: string; entries: ConfigValue[] }> = {};

    for (const entry of CONFIG_REGISTRY) {
      if (!categories[entry.category]) {
        categories[entry.category] = {
          label: CATEGORY_LABELS[entry.category] || entry.category,
          entries: [],
        };
      }

      const dbOverride = this.cache.get(entry.key);
      const envVal = process.env[entry.key];

      let value: string;
      let source: 'database' | 'env' | 'default';

      if (dbOverride) {
        value = entry.is_secret ? '********' : dbOverride.value;
        source = 'database';
      } else if (envVal !== undefined && envVal !== '') {
        value = entry.is_secret ? '********' : envVal;
        source = 'env';
      } else {
        value = entry.is_secret ? '********' : entry.default_value;
        source = 'default';
      }

      categories[entry.category].entries.push({
        ...entry,
        value,
        source,
        updated_at: dbOverride?.updated_at,
        updated_by: dbOverride?.updated_by || undefined,
      });
    }

    return { categories };
  }

  async set(key: string, value: string, adminId: string): Promise<void> {
    const entry = CONFIG_REGISTRY.find(e => e.key === key);
    if (!entry) throw new Error(`Unknown config key: ${key}`);
    if (entry.is_secret) throw new Error('Cannot modify secret values via admin UI');

    await this.db.query(
      `INSERT INTO system_config (key, value, category, description, is_secret, value_type, default_value, updated_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (key) DO UPDATE SET
         value = EXCLUDED.value,
         updated_by = EXCLUDED.updated_by,
         updated_at = NOW()`,
      [key, value, entry.category, entry.description, entry.is_secret, entry.value_type, entry.default_value, adminId]
    );

    // Invalidate cache
    this.lastRefresh = 0;
    logger.info('Config updated', { key, value, adminId });
  }

  async delete(key: string, adminId: string): Promise<void> {
    const entry = CONFIG_REGISTRY.find(e => e.key === key);
    if (!entry) throw new Error(`Unknown config key: ${key}`);
    if (entry.is_secret) throw new Error('Cannot modify secret values via admin UI');

    await this.db.query('DELETE FROM system_config WHERE key = $1', [key]);

    // Invalidate cache
    this.lastRefresh = 0;
    logger.info('Config reset to default', { key, adminId });
  }
}
