/**
 * Committee Service
 * Sync and query committees from Verkhovna Rada API
 */

import { Database } from '../database/database';
import { RadaAPIAdapter } from '../adapters/rada-api-adapter';
import { logger } from '../utils/logger';
import { v4 as uuidv4 } from 'uuid';
import { Committee } from '../types';

export class CommitteeService {
  constructor(
    private db: Database,
    private radaAdapter: RadaAPIAdapter
  ) {
    logger.info('CommitteeService initialized');
  }

  async syncAllCommittees(convocation: number = 9): Promise<number> {
    try {
      logger.info('Syncing all committees', { convocation });

      const rawCommittees = await this.radaAdapter.fetchCommittees(convocation);
      let syncedCount = 0;

      for (const raw of rawCommittees) {
        const committee = this.transformRawCommittee(raw, convocation);
        await this.upsertCommittee(committee);
        syncedCount++;
      }

      logger.info('Committees sync completed', { convocation, syncedCount });
      return syncedCount;
    } catch (error: any) {
      logger.error('Failed to sync committees', { convocation, error: error.message });
      throw error;
    }
  }

  async getCommittees(convocation: number = 9): Promise<Committee[]> {
    const result = await this.db.query(
      'SELECT * FROM committees WHERE convocation = $1 ORDER BY name ASC',
      [convocation]
    );
    return result.rows as Committee[];
  }

  async getCommitteeById(committeeId: string): Promise<Committee | null> {
    const result = await this.db.query(
      'SELECT * FROM committees WHERE committee_id = $1',
      [committeeId]
    );
    return result.rows.length > 0 ? (result.rows[0] as Committee) : null;
  }

  private async upsertCommittee(committee: Committee): Promise<void> {
    await this.db.query(
      `INSERT INTO committees (id, committee_id, name, convocation, member_count, metadata)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (committee_id) DO UPDATE SET
         name = EXCLUDED.name,
         convocation = EXCLUDED.convocation,
         member_count = EXCLUDED.member_count,
         metadata = EXCLUDED.metadata`,
      [
        committee.id,
        committee.committee_id,
        committee.name,
        committee.convocation,
        committee.member_count || null,
        JSON.stringify(committee.metadata || {}),
      ]
    );
  }

  private transformRawCommittee(raw: any, convocation: number): Committee {
    return {
      id: uuidv4(),
      committee_id: String(raw.id || raw.committee_id),
      name: raw.name || raw.title || '',
      convocation,
      member_count: raw.count || raw.member_count || null,
      metadata: raw,
    };
  }
}
