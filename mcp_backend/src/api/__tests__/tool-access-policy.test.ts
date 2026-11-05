import { checkToolAccess, isAdminOnlyTool, scopeVaultArgs, NO_VAULT_OWNER, isAdminUser } from '../tool-access-policy.js';
import { V2_TOOL_NAMES } from '../curated-mcp-tools.js';

const user = { isAdmin: false, viaDbApiKey: false };
const clientKey = { isAdmin: false, viaDbApiKey: true };
const admin = { isAdmin: true, viaDbApiKey: true };

describe('tool-access-policy', () => {
  it('keeps operator tools admin-only', () => {
    for (const t of ['nextcloud_upload', 'nextcloud_share', 'start_import', 'cancel_import',
      'ab_create_experiment', 'ab_update_status', 'workflow_memory_ingest', 'bulk_ingest_court_decisions',
      'search_credentials', 'osint_search_github_leaks']) {
      expect(isAdminOnlyTool(t)).toBe(true);
      expect(checkToolAccess(t, user)).toMatchObject({ allowed: false, reason: 'admin_only' });
      expect(checkToolAccess(t, admin)).toEqual({ allowed: true });
    }
  });

  it('does not treat ordinary tools as operator tools (anchored prefixes)', () => {
    for (const t of ['search_court_decisions', 'get_document', 'search_legislation', 'list_documents']) {
      expect(isAdminOnlyTool(t)).toBe(false);
      expect(checkToolAccess(t, user)).toEqual({ allowed: true });
    }
  });

  it('limits a client API key to the curated v2 set', () => {
    const v2 = [...V2_TOOL_NAMES][0];
    expect(checkToolAccess(v2, clientKey)).toEqual({ allowed: true });
    expect(checkToolAccess('store_document', clientKey)).toMatchObject({ allowed: false, reason: 'api_key_scope' });
    expect(checkToolAccess('build_legal_decision', clientKey)).toMatchObject({ allowed: false });
  });

  it('no admin-only tool is in the curated v2 set', () => {
    expect([...V2_TOOL_NAMES].filter(isAdminOnlyTool)).toEqual([]);
  });

  it('overwrites userId for every vault tool, never leaving it empty', () => {
    const prev = process.env.DEFAULT_VAULT_USER_ID;
    delete process.env.DEFAULT_VAULT_USER_ID;
    try {
      expect(scopeVaultArgs('get_document', { documentId: 'd', userId: 'victim' }, 'me')).toEqual({ documentId: 'd', userId: 'me' });
      expect(scopeVaultArgs('auto_tag_vault_documents', { userId: 'victim' }, 'me')).toEqual({ userId: 'me' });
      expect(scopeVaultArgs('get_document', { documentId: 'd' }, undefined)).toEqual({ documentId: 'd', userId: NO_VAULT_OWNER });
      expect(scopeVaultArgs('search_legislation', { userId: 'x', query: 'q' }, 'me')).toEqual({ userId: 'x', query: 'q' });
    } finally {
      if (prev !== undefined) process.env.DEFAULT_VAULT_USER_ID = prev;
    }
  });

  it('isAdminUser fails closed', async () => {
    const broken = { query: async () => { throw new Error('db down'); } };
    expect(await isAdminUser(broken, 'u-broken')).toBe(false);
    expect(await isAdminUser({ query: async () => ({ rows: [{ admin: true }] }) }, 'u-admin')).toBe(true);
    expect(await isAdminUser({ query: async () => ({ rows: [] }) }, undefined)).toBe(false);
  });
});
