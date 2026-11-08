import type { Tenant } from './types';
import { UA_TENANT } from './ua';

export type { Tenant, Strings, RegistryAdapter } from './types';

const TENANTS: Record<string, () => Tenant> = {
  ua: () => UA_TENANT,
};

/** Registers a tenant under its id (the Polish tenant registers itself when imported). */
export function registerTenant(id: string, build: () => Tenant): void {
  TENANTS[id] = build;
}

export function loadTenant(env: NodeJS.ProcessEnv): Tenant {
  const id = (env.ATTORNEY_CRM_TENANT ?? 'ua').trim().toLowerCase();
  const build = TENANTS[id];
  if (!build) throw new Error(`ATTORNEY_CRM_TENANT must be ${Object.keys(TENANTS).join(' or ')}, got "${id}"`);
  return build();
}

let current: Tenant | null = null;

export function setTenant(t: Tenant): void {
  current = t;
}

/** The active tenant; defaults to ua so code paths and tests without setup behave as before. */
export function tenant(): Tenant {
  return current ?? (current = UA_TENANT);
}
