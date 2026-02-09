import { Database } from '../database/database.js';
import { logger } from '../utils/logger.js';
import { v4 as uuidv4 } from 'uuid';
import { AuditService } from './audit-service.js';

export interface LegalHold {
  id: string;
  matter_id: string;
  hold_name: string;
  hold_type: 'litigation' | 'investigation' | 'regulatory' | 'internal';
  issued_by: string;
  issued_at: Date;
  release_date?: Date;
  released_by?: string;
  scope_description?: string;
  custodians: string[];
  status: 'active' | 'released' | 'expired';
  created_at: Date;
}

export interface CanDeleteResult {
  canDelete: boolean;
  reason?: string;
  holdIds?: string[];
}

export class LegalHoldService {
  constructor(
    private db: Database,
    private auditService: AuditService
  ) {}

  async createHold(
    data: {
      matterId: string;
      holdName: string;
      holdType?: string;
      scopeDescription?: string;
      custodians?: string[];
    },
    issuedBy: string
  ): Promise<LegalHold> {
    const id = uuidv4();

    return await this.db.transaction(async (client) => {
      const result = await client.query(
        `INSERT INTO legal_holds (id, matter_id, hold_name, hold_type, issued_by, scope_description, custodians)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         RETURNING *`,
        [
          id, data.matterId, data.holdName, data.holdType || 'litigation',
          issuedBy, data.scopeDescription || null,
          data.custodians || [],
        ]
      );

      // Set matter legal_hold flag to true
      await client.query(
        `UPDATE matters SET legal_hold = TRUE WHERE id = $1`,
        [data.matterId]
      );

      await this.auditService.log({
        userId: issuedBy,
        action: 'legal_hold.create',
        resourceType: 'legal_hold',
        resourceId: id,
        details: { matterId: data.matterId, holdName: data.holdName, holdType: data.holdType || 'litigation' },
      });

      return result.rows[0];
    });
  }

  async releaseHold(holdId: string, releasedBy: string): Promise<LegalHold | null> {
    return await this.db.transaction(async (client) => {
      const result = await client.query(
        `UPDATE legal_holds SET status = 'released', release_date = NOW(), released_by = $1
         WHERE id = $2 AND status = 'active'
         RETURNING *`,
        [releasedBy, holdId]
      );

      if (result.rows.length === 0) return null;

      const hold = result.rows[0];

      // Check if there are other active holds on this matter
      const otherHolds = await client.query(
        `SELECT 1 FROM legal_holds WHERE matter_id = $1 AND status = 'active' AND id != $2 LIMIT 1`,
        [hold.matter_id, holdId]
      );

      // If no other active holds, clear the matter flag
      if (otherHolds.rows.length === 0) {
        await client.query(
          `UPDATE matters SET legal_hold = FALSE WHERE id = $1`,
          [hold.matter_id]
        );
      }

      await this.auditService.log({
        userId: releasedBy,
        action: 'legal_hold.release',
        resourceType: 'legal_hold',
        resourceId: holdId,
        details: { matterId: hold.matter_id, holdName: hold.hold_name },
      });

      return hold;
    });
  }

  async addDocumentsToHold(
    holdId: string,
    documentIds: string[],
    addedBy: string
  ): Promise<number> {
    let added = 0;

    await this.db.transaction(async (client) => {
      for (const docId of documentIds) {
        try {
          await client.query(
            `INSERT INTO legal_hold_documents (id, legal_hold_id, document_id, added_by)
             VALUES ($1, $2, $3, $4)
             ON CONFLICT (legal_hold_id, document_id) DO NOTHING`,
            [uuidv4(), holdId, docId, addedBy]
          );
          added++;

          // Add custody chain event
          await client.query(
            `INSERT INTO document_custody_chain (id, document_id, event_type, performed_by, details)
             VALUES ($1, $2, 'added_to_legal_hold', $3, $4)`,
            [uuidv4(), docId, addedBy, JSON.stringify({ legalHoldId: holdId })]
          );
        } catch (err: any) {
          logger.warn('[LegalHold] Failed to add document to hold', {
            holdId, docId, error: err.message,
          });
        }
      }
    });

    await this.auditService.log({
      userId: addedBy,
      action: 'legal_hold.add_documents',
      resourceType: 'legal_hold',
      resourceId: holdId,
      details: { documentIds, addedCount: added },
    });

    return added;
  }

  async getHold(holdId: string): Promise<LegalHold | null> {
    const result = await this.db.query(
      `SELECT * FROM legal_holds WHERE id = $1`,
      [holdId]
    );
    return result.rows[0] || null;
  }

  async listHolds(matterId: string): Promise<LegalHold[]> {
    const result = await this.db.query(
      `SELECT * FROM legal_holds WHERE matter_id = $1 ORDER BY created_at DESC`,
      [matterId]
    );
    return result.rows;
  }

  async listActiveHolds(): Promise<LegalHold[]> {
    const result = await this.db.query(
      `SELECT lh.*, m.matter_number, m.matter_name
       FROM legal_holds lh
       JOIN matters m ON m.id = lh.matter_id
       WHERE lh.status = 'active'
       ORDER BY lh.created_at DESC`
    );
    return result.rows;
  }

  async canDeleteDocument(documentId: string): Promise<CanDeleteResult> {
    try {
      const result = await this.db.query(
        `SELECT * FROM can_delete_document($1)`,
        [documentId]
      );
      const row = result.rows[0];
      return {
        canDelete: row.can_delete,
        reason: row.reason || undefined,
        holdIds: row.hold_ids && row.hold_ids.length > 0 ? row.hold_ids : undefined,
      };
    } catch (error: any) {
      logger.error('[LegalHold] canDeleteDocument failed', { documentId, error: error.message });
      // Fail safe: if we can't check, don't allow deletion
      return { canDelete: false, reason: 'Failed to check legal hold status' };
    }
  }

  async addCustodyEvent(
    documentId: string,
    event: {
      eventType: string;
      performedBy?: string;
      ipAddress?: string;
      documentHashBefore?: string;
      documentHashAfter?: string;
      storageLocation?: string;
      details?: any;
    }
  ): Promise<string> {
    const id = uuidv4();
    await this.db.query(
      `INSERT INTO document_custody_chain
        (id, document_id, event_type, performed_by, ip_address, document_hash_before, document_hash_after, storage_location, details)
       VALUES ($1, $2, $3, $4, $5::INET, $6, $7, $8, $9)`,
      [
        id, documentId, event.eventType, event.performedBy || null,
        event.ipAddress || null, event.documentHashBefore || null,
        event.documentHashAfter || null, event.storageLocation || null,
        JSON.stringify(event.details || {}),
      ]
    );
    return id;
  }
}
