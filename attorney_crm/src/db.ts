import { Pool } from 'pg';

// Minimal query surface so repositories can be unit-tested with a fake.
export interface Queryable {
  query<R extends Record<string, unknown> = Record<string, unknown>>(
    text: string,
    values?: unknown[],
  ): Promise<{ rows: R[]; rowCount: number | null }>;
}

/** `schema`, when set, becomes the first search_path entry on every connection (CRM tables live there). */
export function createPool(databaseUrl: string, schema: string | null = null, applicationName = 'attorney_crm'): Pool {
  return new Pool({
    connectionString: databaseUrl,
    max: 5,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
    application_name: applicationName,
    options: schema ? `-c search_path=${schema},public` : undefined,
  });
}
