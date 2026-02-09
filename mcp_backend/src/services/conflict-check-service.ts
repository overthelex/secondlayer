import { Database } from '../database/database.js';
import { logger } from '../utils/logger.js';
import { AuditService } from './audit-service.js';

export interface ConflictResult {
  hasConflicts: boolean;
  conflicts: ConflictMatch[];
  checkedAt: string;
}

export interface ConflictMatch {
  type: 'client_name' | 'tax_id' | 'opposing_party' | 'related_party';
  matchedEntity: string;
  matchedValue: string;
  clientId?: string;
  matterId?: string;
  matterNumber?: string;
}

export class ConflictCheckService {
  constructor(
    private db: Database,
    private auditService: AuditService
  ) {}

  async checkConflicts(
    orgId: string,
    params: {
      partyName: string;
      taxId?: string;
      relatedParties?: string[];
    }
  ): Promise<ConflictResult> {
    const conflicts: ConflictMatch[] = [];

    // 1. Check client_name ILIKE match in the same org
    if (params.partyName) {
      const nameResult = await this.db.query(
        `SELECT id, client_name FROM clients
         WHERE organization_id = $1 AND client_name ILIKE $2 AND status != 'archived'`,
        [orgId, `%${params.partyName}%`]
      );
      for (const row of nameResult.rows) {
        conflicts.push({
          type: 'client_name',
          matchedEntity: 'client',
          matchedValue: row.client_name,
          clientId: row.id,
        });
      }
    }

    // 2. Check tax_id exact match
    if (params.taxId) {
      const taxResult = await this.db.query(
        `SELECT id, client_name, tax_id FROM clients
         WHERE organization_id = $1 AND tax_id = $2 AND status != 'archived'`,
        [orgId, params.taxId]
      );
      for (const row of taxResult.rows) {
        conflicts.push({
          type: 'tax_id',
          matchedEntity: 'client',
          matchedValue: row.tax_id,
          clientId: row.id,
        });
      }
    }

    // 3. Check matters.opposing_party ILIKE match
    if (params.partyName) {
      const opposingResult = await this.db.query(
        `SELECT m.id as matter_id, m.matter_number, m.opposing_party, m.client_id
         FROM matters m
         JOIN clients c ON c.id = m.client_id
         WHERE c.organization_id = $1 AND m.opposing_party ILIKE $2 AND m.status != 'archived'`,
        [orgId, `%${params.partyName}%`]
      );
      for (const row of opposingResult.rows) {
        conflicts.push({
          type: 'opposing_party',
          matchedEntity: 'matter',
          matchedValue: row.opposing_party,
          matterId: row.matter_id,
          matterNumber: row.matter_number,
          clientId: row.client_id,
        });
      }
    }

    // 4. Check matters.related_parties JSONB containment
    const partiesToCheck = [params.partyName, ...(params.relatedParties || [])].filter(Boolean);
    for (const party of partiesToCheck) {
      const relatedResult = await this.db.query(
        `SELECT m.id as matter_id, m.matter_number, m.related_parties, m.client_id
         FROM matters m
         JOIN clients c ON c.id = m.client_id
         WHERE c.organization_id = $1 AND m.status != 'archived'
           AND EXISTS (
             SELECT 1 FROM jsonb_array_elements_text(m.related_parties) rp
             WHERE rp ILIKE $2
           )`,
        [orgId, `%${party}%`]
      );
      for (const row of relatedResult.rows) {
        conflicts.push({
          type: 'related_party',
          matchedEntity: 'matter',
          matchedValue: party!,
          matterId: row.matter_id,
          matterNumber: row.matter_number,
          clientId: row.client_id,
        });
      }
    }

    return {
      hasConflicts: conflicts.length > 0,
      conflicts,
      checkedAt: new Date().toISOString(),
    };
  }

  async runFullConflictCheck(clientId: string, userId: string): Promise<ConflictResult> {
    // Load client data
    const clientResult = await this.db.query(
      `SELECT * FROM clients WHERE id = $1`,
      [clientId]
    );

    if (clientResult.rows.length === 0) {
      throw new Error('Client not found');
    }

    const client = clientResult.rows[0];

    // Load matters for this client to gather related parties
    const mattersResult = await this.db.query(
      `SELECT opposing_party, related_parties FROM matters WHERE client_id = $1`,
      [clientId]
    );

    const relatedParties: string[] = [];
    for (const m of mattersResult.rows) {
      if (m.opposing_party) relatedParties.push(m.opposing_party);
      if (Array.isArray(m.related_parties)) {
        relatedParties.push(...m.related_parties.filter((p: any) => typeof p === 'string'));
      }
    }

    const result = await this.checkConflicts(client.organization_id, {
      partyName: client.client_name,
      taxId: client.tax_id || undefined,
      relatedParties,
    });

    // Filter out self-references (matches against the same client)
    result.conflicts = result.conflicts.filter((c) => c.clientId !== clientId);
    result.hasConflicts = result.conflicts.length > 0;

    // Update client conflict status
    const newStatus = result.hasConflicts ? 'flagged' : 'clear';
    await this.db.query(
      `UPDATE clients SET conflict_check_date = NOW(), conflict_status = $1 WHERE id = $2`,
      [newStatus, clientId]
    );

    await this.auditService.log({
      userId,
      action: 'conflict.check',
      resourceType: 'client',
      resourceId: clientId,
      details: {
        hasConflicts: result.hasConflicts,
        conflictsCount: result.conflicts.length,
        newStatus,
      },
    });

    logger.info('[ConflictCheck] Full check completed', {
      clientId,
      hasConflicts: result.hasConflicts,
      conflictsCount: result.conflicts.length,
    });

    return result;
  }
}
