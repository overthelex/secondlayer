/**
 * Deputy Service
 * CRUD operations for deputies with intelligent PostgreSQL caching (7-day TTL)
 */

import { Database } from '../database/database';
import { logger } from '../utils/logger';
import { RadaAPIAdapter } from '../adapters/rada-api-adapter';
import { v4 as uuidv4 } from 'uuid';
import {
  Deputy,
  DeputyAssistant,
  DeputyInfoResult,
  DeputySearchParams,
} from '../types';

export class DeputyService {
  private cacheTTLSeconds: number;

  constructor(
    private db: Database,
    private radaAdapter: RadaAPIAdapter
  ) {
    // Default: 7 days, can be overridden by env
    this.cacheTTLSeconds = parseInt(process.env.CACHE_TTL_DEPUTIES || '604800', 10);
    logger.info('DeputyService initialized', { cacheTTL: this.cacheTTLSeconds });
  }

  /**
   * Get deputy by RADA ID with cache-first strategy
   */
  async getDeputyByRadaId(
    radaId: string,
    convocation: number = 9,
    forceRefresh: boolean = false
  ): Promise<Deputy | null> {
    try {
      // Step 1: Check cache if not forcing refresh
      if (!forceRefresh) {
        const cached = await this.getCachedDeputy(radaId);
        if (cached) {
          logger.debug('Deputy found in cache', { radaId });
          return cached;
        }
      }

      // Step 2: Fetch from RADA API
      logger.info('Fetching deputy from RADA API', { radaId, convocation });
      const rawData = await this.radaAdapter.fetchDeputyById(radaId, convocation);

      if (!rawData) {
        logger.warn('Deputy not found in RADA API', { radaId });
        return null;
      }

      // Step 3: Transform and upsert to database
      const deputy = this.transformRawDeputy(rawData, convocation);
      await this.upsertDeputy(deputy);

      return deputy;
    } catch (error: any) {
      logger.error('Failed to get deputy', { radaId, error: error.message });
      throw error;
    }
  }

  /**
   * Search deputies with flexible filters
   */
  async searchDeputies(params: DeputySearchParams): Promise<DeputyInfoResult[]> {
    try {
      let query = 'SELECT * FROM deputies WHERE 1=1';
      const queryParams: any[] = [];
      let paramIndex = 1;

      // Filter by name (partial match)
      if (params.name) {
        query += ` AND (full_name ILIKE $${paramIndex} OR short_name ILIKE $${paramIndex})`;
        queryParams.push(`%${params.name}%`);
        paramIndex++;
      }

      // Filter by rada_id
      if (params.rada_id) {
        query += ` AND rada_id = $${paramIndex}`;
        queryParams.push(params.rada_id);
        paramIndex++;
      }

      // Filter by faction
      if (params.faction) {
        query += ` AND faction_name ILIKE $${paramIndex}`;
        queryParams.push(`%${params.faction}%`);
        paramIndex++;
      }

      // Filter by committee
      if (params.committee) {
        query += ` AND committee_name ILIKE $${paramIndex}`;
        queryParams.push(`%${params.committee}%`);
        paramIndex++;
      }

      // Filter by active status
      if (params.active !== undefined) {
        query += ` AND active = $${paramIndex}`;
        queryParams.push(params.active);
        paramIndex++;
      }

      const limit = params.faction ? 500 : 100;
      query += ` ORDER BY full_name ASC LIMIT ${limit}`;

      const result = await this.db.query(query, queryParams);
      const deputies = result.rows as Deputy[];

      // Build full results with optional related data
      const results: DeputyInfoResult[] = [];
      for (const deputy of deputies) {
        const info: DeputyInfoResult = { deputy };

        if (params.include_assistants) {
          info.assistants = await this.getDeputyAssistants(deputy.rada_id);
        }

        if (params.include_voting_record) {
          info.voting_statistics = await this.getVotingStatistics(deputy.rada_id);
        }

        results.push(info);
      }

      logger.info('Deputies search completed', {
        params,
        resultsCount: results.length,
      });

      return results;
    } catch (error: any) {
      logger.error('Failed to search deputies', {
        params,
        error: error.message,
      });
      throw error;
    }
  }

  /**
   * Sync all deputies for a convocation
   */
  async syncAllDeputies(convocation: number = 9): Promise<number> {
    try {
      logger.info('Syncing all deputies', { convocation });

      const allDeputies = await this.radaAdapter.fetchDeputies(convocation);
      let syncedCount = 0;

      for (const rawDeputy of allDeputies) {
        const deputy = this.transformRawDeputy(rawDeputy, convocation);
        await this.upsertDeputy(deputy);
        syncedCount++;
      }

      logger.info('Deputies sync completed', { convocation, syncedCount });
      return syncedCount;
    } catch (error: any) {
      logger.error('Failed to sync deputies', {
        convocation,
        error: error.message,
      });
      throw error;
    }
  }

  /**
   * Get deputy assistants
   */
  async getDeputyAssistants(radaId: string, convocation: number = 9): Promise<DeputyAssistant[]> {
    try {
      // First try to get from database
      const deputy = await this.getDeputyByRadaId(radaId, convocation);
      if (!deputy) {
        return [];
      }

      const result = await this.db.query(
        'SELECT * FROM deputy_assistants WHERE deputy_id = $1',
        [deputy.id]
      );

      // If no assistants in DB, fetch from API
      if (result.rows.length === 0) {
        const rawAssistants = await this.radaAdapter.fetchDeputyAssistants(
          radaId,
          convocation
        );

        if (rawAssistants.length > 0 && deputy.id) {
          await this.saveAssistants(deputy.id, rawAssistants);
          return await this.getDeputyAssistants(radaId, convocation);
        }
      }

      return result.rows as DeputyAssistant[];
    } catch (error: any) {
      logger.error('Failed to get deputy assistants', {
        radaId,
        error: error.message,
      });
      return [];
    }
  }

  /**
   * Get cached deputy (only if not expired)
   */
  private async getCachedDeputy(radaId: string): Promise<Deputy | null> {
    try {
      const result = await this.db.query(
        'SELECT * FROM deputies WHERE rada_id = $1 AND cache_expires_at > NOW()',
        [radaId]
      );

      if (result.rows.length === 0) {
        return null;
      }

      return result.rows[0] as Deputy;
    } catch (error: any) {
      logger.error('Failed to get cached deputy', {
        radaId,
        error: error.message,
      });
      return null;
    }
  }

  /**
   * Upsert deputy with new TTL
   */
  private async upsertDeputy(deputy: Deputy): Promise<string> {
    try {
      const id = deputy.id || uuidv4();
      const cacheExpires = new Date(
        Date.now() + this.cacheTTLSeconds * 1000
      );

      const query = `
        INSERT INTO deputies (
          id, rada_id, full_name, short_name, convocation, active, status,
          faction_id, faction_name, committee_id, committee_name, committee_role,
          gender, birth_date, birth_place, region, district, phone, email,
          photo_url, biography, assistant_count, metadata,
          cached_at, cache_expires_at, last_synced, updated_at
        ) VALUES (
          $1, $2, $3, $4, $5, $6, $7,
          $8, $9, $10, $11, $12,
          $13, $14, $15, $16, $17, $18, $19,
          $20, $21, $22, $23,
          NOW(), $24, NOW(), NOW()
        )
        ON CONFLICT (rada_id)
        DO UPDATE SET
          full_name = EXCLUDED.full_name,
          short_name = EXCLUDED.short_name,
          convocation = EXCLUDED.convocation,
          active = EXCLUDED.active,
          status = EXCLUDED.status,
          faction_id = EXCLUDED.faction_id,
          faction_name = EXCLUDED.faction_name,
          committee_id = EXCLUDED.committee_id,
          committee_name = EXCLUDED.committee_name,
          committee_role = EXCLUDED.committee_role,
          gender = EXCLUDED.gender,
          birth_date = EXCLUDED.birth_date,
          birth_place = EXCLUDED.birth_place,
          region = EXCLUDED.region,
          district = EXCLUDED.district,
          phone = EXCLUDED.phone,
          email = EXCLUDED.email,
          photo_url = EXCLUDED.photo_url,
          biography = EXCLUDED.biography,
          assistant_count = EXCLUDED.assistant_count,
          metadata = deputies.metadata || EXCLUDED.metadata,
          cached_at = NOW(),
          cache_expires_at = EXCLUDED.cache_expires_at,
          last_synced = NOW(),
          updated_at = NOW()
        RETURNING id
      `;

      const result = await this.db.query(query, [
        id,
        deputy.rada_id,
        deputy.full_name,
        deputy.short_name || null,
        deputy.convocation,
        deputy.active !== undefined ? deputy.active : true,
        deputy.status || null,
        deputy.faction_id || null,
        deputy.faction_name || null,
        deputy.committee_id || null,
        deputy.committee_name || null,
        deputy.committee_role || null,
        deputy.gender || null,
        deputy.birth_date || null,
        deputy.birth_place || null,
        deputy.region || null,
        deputy.district || null,
        deputy.phone || null,
        deputy.email || null,
        deputy.photo_url || null,
        deputy.biography || null,
        deputy.assistant_count || 0,
        JSON.stringify(deputy.metadata || {}),
        cacheExpires,
      ]);

      const savedId = result.rows[0].id;

      logger.debug('Deputy upserted', {
        rada_id: deputy.rada_id,
        id: savedId,
        cacheExpires,
      });

      return savedId;
    } catch (error: any) {
      logger.error('Failed to upsert deputy', {
        rada_id: deputy.rada_id,
        error: error.message,
      });
      throw error;
    }
  }

  /**
   * Save deputy assistants
   */
  private async saveAssistants(deputyId: string, rawAssistants: any[]): Promise<void> {
    try {
      await this.db.transaction(async (client) => {
        // Delete existing assistants
        await client.query('DELETE FROM deputy_assistants WHERE deputy_id = $1', [
          deputyId,
        ]);

        // Insert new assistants
        for (const raw of rawAssistants) {
          await client.query(
            `INSERT INTO deputy_assistants (
              id, deputy_id, assistant_type, full_name, start_date, end_date, metadata
            ) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
            [
              uuidv4(),
              deputyId,
              raw.assistant_type || raw.type || null,
              raw.full_name || raw.name || null,
              raw.start_date || null,
              raw.end_date || null,
              JSON.stringify(raw),
            ]
          );
        }
      });

      logger.debug('Deputy assistants saved', {
        deputyId,
        count: rawAssistants.length,
      });
    } catch (error: any) {
      logger.error('Failed to save assistants', {
        deputyId,
        error: error.message,
      });
      throw error;
    }
  }

  /**
   * Transform raw RADA API data to Deputy type
   */
  private transformRawDeputy(raw: any, convocation: number): Deputy {
    // Build full name from surname, firstname, patronymic or use existing full_name
    let fullName = raw.full_name || raw.name;
    let shortName = raw.short_name;

    if (!fullName && (raw.surname || raw.firstname)) {
      const nameParts = [
        raw.surname || '',
        raw.firstname || '',
        raw.patronymic || ''
      ].filter(p => p);
      fullName = nameParts.join(' ');
      shortName = `${raw.surname || ''} ${raw.firstname || ''}`.trim();
    }

    // Extract faction from post_frs array
    let factionId = raw.current_fr_id || raw.faction_id || null;
    let factionName = raw.current_fr_name || raw.faction_name || null;

    if (!factionName && raw.post_frs && Array.isArray(raw.post_frs)) {
      const factionPost = raw.post_frs.find((p: any) => p.is_fr === 1);
      if (factionPost) {
        factionId = factionPost.fr_association_id || null;
        factionName = factionPost.association_name || null;
      }
    }

    // Extract primary committee from post_frs array
    let committeeId = raw.main_komitet_id || raw.committee_id || null;
    let committeeName = raw.main_komitet_name || raw.committee_name || null;
    let committeeRole = raw.main_komitet_role || raw.committee_role || null;

    if (!committeeName && raw.post_frs && Array.isArray(raw.post_frs)) {
      const committeePost = raw.post_frs.find((p: any) =>
        p.type === 2 || (p.association_name && p.association_name.includes('Комітет'))
      );
      if (committeePost) {
        committeeId = committeePost.fr_association_id || null;
        committeeName = committeePost.association_name || null;
        committeeRole = committeePost.post_name || null;
      }
    }

    // Truncate long fields to fit VARCHAR(255)
    if (committeeName && committeeName.length > 255) {
      committeeName = committeeName.substring(0, 252) + '...';
    }
    if (factionName && factionName.length > 255) {
      factionName = factionName.substring(0, 252) + '...';
    }
    if (committeeRole && committeeRole.length > 100) {
      committeeRole = committeeRole.substring(0, 97) + '...';
    }

    return {
      id: raw.uuid || uuidv4(),
      rada_id: String(raw.rada_id || raw.id),
      full_name: fullName,
      short_name: shortName || fullName,
      convocation,
      active: raw.resignation_date ? false : (raw.active_mps !== undefined ? raw.active_mps : true),
      status: raw.status || null,
      faction_id: factionId ? String(factionId) : undefined,
      faction_name: factionName || undefined,
      committee_id: committeeId ? String(committeeId) : undefined,
      committee_name: committeeName || undefined,
      committee_role: committeeRole || undefined,
      gender: raw.gender === 1 ? 'M' : raw.gender === 2 ? 'F' : (raw.sex || raw.gender || null),
      birth_date: raw.birthday || raw.birth_date || null,
      birth_place: raw.birth_place || null,
      region: raw.region_name || raw.region || null,
      district: raw.district_num ? String(raw.district_num) : (raw.district || null),
      phone: raw.phones && raw.phones.length > 0 ? raw.phones[0].value : (raw.phone || null),
      email: raw.email || null,
      photo_url: raw.photo || raw.photo_url || null,
      biography: raw.short_info || raw.bio || raw.biography || null,
      assistant_count: raw.assistants && Array.isArray(raw.assistants) ? raw.assistants.length : (raw.assistant_count || 0),
      metadata: raw,
    };
  }

  /**
   * Get voting statistics for a deputy
   * This is a placeholder - actual implementation in voting-service.ts
   */
  private async getVotingStatistics(_radaId: string): Promise<any> {
    // TODO: Implement in voting-service.ts
    return {
      total_votes: 0,
      voted_for: 0,
      voted_against: 0,
      abstained: 0,
      not_present: 0,
      attendance_rate: 0,
      positions: [],
    };
  }

  /**
   * Get database statistics
   */
  async getStats(): Promise<any> {
    try {
      const result = await this.db.query(`
        SELECT
          COUNT(*) as total_deputies,
          COUNT(CASE WHEN active = true THEN 1 END) as active_deputies,
          COUNT(CASE WHEN cache_expires_at > NOW() THEN 1 END) as cached_deputies,
          COUNT(DISTINCT faction_id) as unique_factions,
          COUNT(DISTINCT committee_id) as unique_committees,
          MIN(cached_at) as oldest_cache,
          MAX(cached_at) as newest_cache
        FROM deputies
      `);

      return result.rows[0];
    } catch (error) {
      logger.error('Failed to get deputy stats:', error);
      return null;
    }
  }
}
