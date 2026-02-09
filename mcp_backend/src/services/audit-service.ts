import { Database } from '../database/database.js';
import { logger } from '../utils/logger.js';

export interface AuditLogEntry {
  id: string;
  user_id: string | null;
  action: string;
  resource_type: string;
  resource_id: string | null;
  ip_address: string | null;
  user_agent: string | null;
  details: any;
  previous_hash: string;
  current_hash: string;
  created_at: Date;
}

export interface AuditLogFilters {
  userId?: string;
  action?: string;
  resourceType?: string;
  resourceId?: string;
  dateFrom?: string;
  dateTo?: string;
  limit?: number;
  offset?: number;
}

export class AuditService {
  constructor(private db: Database) {}

  async log(params: {
    userId?: string;
    action: string;
    resourceType: string;
    resourceId?: string;
    ipAddress?: string;
    userAgent?: string;
    details?: any;
  }): Promise<string> {
    try {
      const result = await this.db.query(
        `SELECT add_audit_log($1, $2, $3, $4, $5::INET, $6, $7) AS id`,
        [
          params.userId || null,
          params.action,
          params.resourceType,
          params.resourceId || null,
          params.ipAddress || null,
          params.userAgent || null,
          JSON.stringify(params.details || {}),
        ]
      );
      return result.rows[0].id;
    } catch (error: any) {
      logger.error('[Audit] Failed to log entry', { error: error.message, action: params.action });
      throw error;
    }
  }

  async validateChain(): Promise<{
    isValid: boolean;
    invalidEntryId?: string;
    expectedHash?: string;
    actualHash?: string;
    entriesChecked: number;
  }> {
    try {
      const result = await this.db.query(`SELECT * FROM validate_audit_chain()`);
      const row = result.rows[0];
      return {
        isValid: row.is_valid,
        invalidEntryId: row.invalid_entry_id || undefined,
        expectedHash: row.expected_hash || undefined,
        actualHash: row.actual_hash || undefined,
        entriesChecked: row.entries_checked,
      };
    } catch (error: any) {
      logger.error('[Audit] Chain validation failed', { error: error.message });
      throw error;
    }
  }

  async getAuditLog(filters: AuditLogFilters = {}): Promise<{
    entries: AuditLogEntry[];
    total: number;
  }> {
    const limit = filters.limit || 50;
    const offset = filters.offset || 0;
    const conditions: string[] = [];
    const params: any[] = [];
    let paramIndex = 1;

    if (filters.userId) {
      conditions.push(`user_id = $${paramIndex++}`);
      params.push(filters.userId);
    }
    if (filters.action) {
      conditions.push(`action = $${paramIndex++}`);
      params.push(filters.action);
    }
    if (filters.resourceType) {
      conditions.push(`resource_type = $${paramIndex++}`);
      params.push(filters.resourceType);
    }
    if (filters.resourceId) {
      conditions.push(`resource_id = $${paramIndex++}`);
      params.push(filters.resourceId);
    }
    if (filters.dateFrom) {
      conditions.push(`created_at >= $${paramIndex++}`);
      params.push(filters.dateFrom);
    }
    if (filters.dateTo) {
      conditions.push(`created_at <= $${paramIndex++}`);
      params.push(filters.dateTo);
    }

    const where = conditions.length > 0 ? 'WHERE ' + conditions.join(' AND ') : '';

    const [result, countResult] = await Promise.all([
      this.db.query(
        `SELECT * FROM audit_log ${where}
         ORDER BY created_at DESC
         LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`,
        [...params, limit, offset]
      ),
      this.db.query(`SELECT COUNT(*) FROM audit_log ${where}`, params),
    ]);

    return {
      entries: result.rows,
      total: parseInt(countResult.rows[0].count, 10),
    };
  }

  async exportAuditLog(filters: AuditLogFilters = {}): Promise<AuditLogEntry[]> {
    const conditions: string[] = [];
    const params: any[] = [];
    let paramIndex = 1;

    if (filters.userId) {
      conditions.push(`user_id = $${paramIndex++}`);
      params.push(filters.userId);
    }
    if (filters.action) {
      conditions.push(`action = $${paramIndex++}`);
      params.push(filters.action);
    }
    if (filters.resourceType) {
      conditions.push(`resource_type = $${paramIndex++}`);
      params.push(filters.resourceType);
    }
    if (filters.dateFrom) {
      conditions.push(`created_at >= $${paramIndex++}`);
      params.push(filters.dateFrom);
    }
    if (filters.dateTo) {
      conditions.push(`created_at <= $${paramIndex++}`);
      params.push(filters.dateTo);
    }

    const where = conditions.length > 0 ? 'WHERE ' + conditions.join(' AND ') : '';

    const result = await this.db.query(
      `SELECT * FROM audit_log ${where} ORDER BY created_at ASC`,
      params
    );
    return result.rows;
  }
}
