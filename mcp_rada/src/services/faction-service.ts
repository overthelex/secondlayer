/**
 * Faction Service
 * Sync and query factions from Verkhovna Rada API
 */

import { Database } from '../database/database';
import { RadaAPIAdapter } from '../adapters/rada-api-adapter';
import { logger } from '../utils/logger';
import { v4 as uuidv4 } from 'uuid';
import { Faction } from '../types';

export class FactionService {
  constructor(
    private db: Database,
    private radaAdapter: RadaAPIAdapter
  ) {
    logger.info('FactionService initialized');
  }

  async syncAllFactions(convocation: number = 9): Promise<number> {
    try {
      logger.info('Syncing all factions', { convocation });

      const rawFactions = await this.radaAdapter.fetchFactions(convocation);
      let syncedCount = 0;

      for (const raw of rawFactions) {
        const faction = this.transformRawFaction(raw, convocation);
        await this.upsertFaction(faction);
        syncedCount++;
      }

      logger.info('Factions sync completed', { convocation, syncedCount });
      return syncedCount;
    } catch (error: any) {
      logger.error('Failed to sync factions', { convocation, error: error.message });
      throw error;
    }
  }

  async getFactions(convocation: number = 9): Promise<Faction[]> {
    const result = await this.db.query(
      'SELECT * FROM factions WHERE convocation = $1 ORDER BY name ASC',
      [convocation]
    );
    return result.rows as Faction[];
  }

  async getFactionById(factionId: string): Promise<Faction | null> {
    const result = await this.db.query(
      'SELECT * FROM factions WHERE faction_id = $1',
      [factionId]
    );
    return result.rows.length > 0 ? (result.rows[0] as Faction) : null;
  }

  private async upsertFaction(faction: Faction): Promise<void> {
    await this.db.query(
      `INSERT INTO factions (id, faction_id, name, convocation, member_count, created_date, metadata)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (faction_id) DO UPDATE SET
         name = EXCLUDED.name,
         convocation = EXCLUDED.convocation,
         member_count = EXCLUDED.member_count,
         created_date = EXCLUDED.created_date,
         metadata = EXCLUDED.metadata`,
      [
        faction.id,
        faction.faction_id,
        faction.name,
        faction.convocation,
        faction.member_count || null,
        faction.created_date || null,
        JSON.stringify(faction.metadata || {}),
      ]
    );
  }

  private transformRawFaction(raw: any, convocation: number): Faction {
    return {
      id: uuidv4(),
      faction_id: String(raw.id || raw.faction_id),
      name: raw.name || raw.title || '',
      convocation,
      member_count: raw.count || raw.member_count || null,
      created_date: raw.created || raw.created_date || null,
      metadata: raw,
    };
  }
}
