import { Pool } from 'pg';
import { z } from 'zod';

export interface RegistrySearchParams {
  query?: string;
  edrpou?: string;
  record?: string;
  entityType?: 'UO' | 'FOP' | 'FSU' | 'ALL';
  stan?: string;
  limit?: number;
  offset?: number;
}

export interface EntityDetails {
  entityType: 'UO' | 'FOP' | 'FSU';
  record: string;
  mainInfo: any;
  founders?: any[];
  beneficiaries?: any[];
  signers?: any[];
  members?: any[];
  branches?: any[];
  predecessors?: any[];
  assignees?: any[];
  executivePower?: any;
  terminationStarted?: any;
  bankruptcyInfo?: any;
  exchangeData?: any[];
}

export class OpenReyestrTools {
  private pool: Pool;

  constructor(pool: Pool) {
    this.pool = pool;
  }

  /**
   * Search for entities in the registry by name, EDRPOU, or other criteria
   */
  async searchEntities(params: RegistrySearchParams): Promise<any[]> {
    const {
      query,
      edrpou,
      record,
      entityType = 'ALL',
      stan,
      limit = 50,
      offset = 0,
    } = params;

    const results: any[] = [];

    // Search legal entities (UO)
    if (entityType === 'UO' || entityType === 'ALL') {
      const conditions: string[] = [];
      const values: any[] = [];
      let paramIndex = 1;

      if (query) {
        conditions.push(`(name ILIKE $${paramIndex} OR short_name ILIKE $${paramIndex})`);
        values.push(`%${query}%`);
        paramIndex++;
      }

      if (edrpou) {
        conditions.push(`edrpou = $${paramIndex}`);
        values.push(edrpou);
        paramIndex++;
      }

      if (record) {
        conditions.push(`record = $${paramIndex}`);
        values.push(record);
        paramIndex++;
      }

      if (stan) {
        conditions.push(`stan = $${paramIndex}`);
        values.push(stan);
        paramIndex++;
      }

      const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

      values.push(limit, offset);
      const result = await this.pool.query(
        `SELECT id, record, edrpou, name, short_name, opf, stan, registration, 'UO' as entity_type
         FROM legal_entities
         ${whereClause}
         ORDER BY id DESC
         LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`,
        values
      );

      results.push(...result.rows);
    }

    // Search individual entrepreneurs (FOP)
    if (entityType === 'FOP' || entityType === 'ALL') {
      const conditions: string[] = [];
      const values: any[] = [];
      let paramIndex = 1;

      if (query) {
        conditions.push(`name ILIKE $${paramIndex}`);
        values.push(`%${query}%`);
        paramIndex++;
      }

      if (record) {
        conditions.push(`record = $${paramIndex}`);
        values.push(record);
        paramIndex++;
      }

      if (stan) {
        conditions.push(`stan = $${paramIndex}`);
        values.push(stan);
        paramIndex++;
      }

      const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

      values.push(limit, offset);
      const result = await this.pool.query(
        `SELECT id, record, name, stan, registration, 'FOP' as entity_type
         FROM individual_entrepreneurs
         ${whereClause}
         ORDER BY id DESC
         LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`,
        values
      );

      results.push(...result.rows);
    }

    // Search public associations (FSU)
    if (entityType === 'FSU' || entityType === 'ALL') {
      const conditions: string[] = [];
      const values: any[] = [];
      let paramIndex = 1;

      if (query) {
        conditions.push(`(name ILIKE $${paramIndex} OR short_name ILIKE $${paramIndex})`);
        values.push(`%${query}%`);
        paramIndex++;
      }

      if (edrpou) {
        conditions.push(`edrpou = $${paramIndex}`);
        values.push(edrpou);
        paramIndex++;
      }

      if (record) {
        conditions.push(`record = $${paramIndex}`);
        values.push(record);
        paramIndex++;
      }

      if (stan) {
        conditions.push(`stan = $${paramIndex}`);
        values.push(stan);
        paramIndex++;
      }

      const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

      values.push(limit, offset);
      const result = await this.pool.query(
        `SELECT id, record, edrpou, name, short_name, type_subject, type_branch, stan, registration, 'FSU' as entity_type
         FROM public_associations
         ${whereClause}
         ORDER BY id DESC
         LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`,
        values
      );

      results.push(...result.rows);
    }

    const sliced = results.slice(0, limit);

    if (sliced.length === 0) {
      const registries = await this.getRegistrySummary();
      return [{
        found: false,
        query: query || edrpou || record || '',
        message: `Не знайдено суб'єктів за вашим запитом в Єдиному державному реєстрі`,
        availableRegistries: registries,
        suggestions: [
          'Спробуйте скоротити або змінити пошуковий запит',
          'Для пошуку за кодом ЄДРПОУ використовуйте openreyestr_get_by_edrpou',
          'ФОП не мають ЄДРПОУ — шукайте за прізвищем через search_entities',
        ],
      }];
    }

    return sliced;
  }

  /**
   * Get full details of an entity including all related data
   */
  async getEntityDetails(record: string, entityType?: 'UO' | 'FOP' | 'FSU'): Promise<EntityDetails | null> {
    // If entity type not specified, try to find it
    if (!entityType) {
      const typeResult = await this.findEntityType(record);
      if (!typeResult) {
        return null;
      }
      entityType = typeResult;
    }

    let mainInfo: any;

    // Get main entity info
    if (entityType === 'UO') {
      const result = await this.pool.query(
        'SELECT * FROM legal_entities WHERE record = $1',
        [record]
      );
      if (result.rows.length === 0) return null;
      mainInfo = result.rows[0];
    } else if (entityType === 'FOP') {
      const result = await this.pool.query(
        'SELECT * FROM individual_entrepreneurs WHERE record = $1',
        [record]
      );
      if (result.rows.length === 0) return null;
      mainInfo = result.rows[0];
    } else if (entityType === 'FSU') {
      const result = await this.pool.query(
        'SELECT * FROM public_associations WHERE record = $1',
        [record]
      );
      if (result.rows.length === 0) return null;
      mainInfo = result.rows[0];
    } else {
      return null;
    }

    const details: EntityDetails = {
      entityType,
      record,
      mainInfo,
    };

    // Get related data
    const foundersResult = await this.pool.query(
      'SELECT * FROM founders WHERE entity_type = $1 AND entity_record = $2',
      [entityType, record]
    );
    if (foundersResult.rows.length > 0) {
      details.founders = foundersResult.rows;
    }

    const beneficiariesResult = await this.pool.query(
      'SELECT * FROM beneficiaries WHERE entity_type = $1 AND entity_record = $2',
      [entityType, record]
    );
    if (beneficiariesResult.rows.length > 0) {
      details.beneficiaries = beneficiariesResult.rows;
    }

    const signersResult = await this.pool.query(
      'SELECT * FROM signers WHERE entity_type = $1 AND entity_record = $2',
      [entityType, record]
    );
    if (signersResult.rows.length > 0) {
      details.signers = signersResult.rows;
    }

    if (entityType === 'UO') {
      const membersResult = await this.pool.query(
        'SELECT * FROM members WHERE entity_record = $1',
        [record]
      );
      if (membersResult.rows.length > 0) {
        details.members = membersResult.rows;
      }

      const branchesResult = await this.pool.query(
        'SELECT * FROM branches WHERE parent_record = $1',
        [record]
      );
      if (branchesResult.rows.length > 0) {
        details.branches = branchesResult.rows;
      }

      const assigneesResult = await this.pool.query(
        'SELECT * FROM assignees WHERE entity_record = $1',
        [record]
      );
      if (assigneesResult.rows.length > 0) {
        details.assignees = assigneesResult.rows;
      }

      const executivePowerResult = await this.pool.query(
        'SELECT * FROM executive_power WHERE entity_record = $1',
        [record]
      );
      if (executivePowerResult.rows.length > 0) {
        details.executivePower = executivePowerResult.rows[0];
      }

      const bankruptcyResult = await this.pool.query(
        'SELECT * FROM bankruptcy_info WHERE entity_record = $1',
        [record]
      );
      if (bankruptcyResult.rows.length > 0) {
        details.bankruptcyInfo = bankruptcyResult.rows[0];
      }
    }

    const predecessorsResult = await this.pool.query(
      'SELECT * FROM predecessors WHERE entity_type = $1 AND entity_record = $2',
      [entityType, record]
    );
    if (predecessorsResult.rows.length > 0) {
      details.predecessors = predecessorsResult.rows;
    }

    const terminationResult = await this.pool.query(
      'SELECT * FROM termination_started WHERE entity_type = $1 AND entity_record = $2',
      [entityType, record]
    );
    if (terminationResult.rows.length > 0) {
      details.terminationStarted = terminationResult.rows[0];
    }

    const exchangeDataResult = await this.pool.query(
      'SELECT * FROM exchange_data WHERE entity_type = $1 AND entity_record = $2',
      [entityType, record]
    );
    if (exchangeDataResult.rows.length > 0) {
      details.exchangeData = exchangeDataResult.rows;
    }

    return details;
  }

  /**
   * Search for beneficiaries by name
   */
  async searchBeneficiaries(query: string, limit: number = 50): Promise<any[]> {
    const result = await this.pool.query(
      `SELECT b.*,
              CASE
                WHEN le.name IS NOT NULL THEN le.name
                WHEN ie.name IS NOT NULL THEN ie.name
                WHEN pa.name IS NOT NULL THEN pa.name
              END as entity_name,
              b.entity_type
       FROM beneficiaries b
       LEFT JOIN legal_entities le ON b.entity_type = 'UO' AND b.entity_record = le.record
       LEFT JOIN individual_entrepreneurs ie ON b.entity_type = 'FOP' AND b.entity_record = ie.record
       LEFT JOIN public_associations pa ON b.entity_type = 'FSU' AND b.entity_record = pa.record
       WHERE b.beneficiary_info ILIKE $1
       LIMIT $2`,
      [`%${query}%`, limit]
    );

    return result.rows;
  }

  /**
   * Get entity by EDRPOU code
   */
  async getByEdrpou(edrpou: string): Promise<any | null> {
    // Try legal entities first
    const uoResult = await this.pool.query(
      'SELECT *, \'UO\' as entity_type FROM legal_entities WHERE edrpou = $1',
      [edrpou]
    );

    if (uoResult.rows.length > 0) {
      return uoResult.rows[0];
    }

    // Try public associations
    const fsuResult = await this.pool.query(
      'SELECT *, \'FSU\' as entity_type FROM public_associations WHERE edrpou = $1',
      [edrpou]
    );

    if (fsuResult.rows.length > 0) {
      return fsuResult.rows[0];
    }

    const registries = await this.getRegistrySummary();
    return {
      found: false,
      edrpou,
      message: `Суб'єкт з ЄДРПОУ ${edrpou} не знайдено в Єдиному державному реєстрі`,
      availableRegistries: registries,
      suggestions: [
        'Перевірте правильність коду ЄДРПОУ',
        'Спробуйте пошук за назвою через openreyestr_search_entities',
        'ФОП не мають ЄДРПОУ — використовуйте пошук за іменем',
      ],
    };
  }

  /**
   * Get registry statistics
   */
  async getStatistics(): Promise<any> {
    const uoCount = await this.pool.query('SELECT COUNT(*) FROM legal_entities');
    const fopCount = await this.pool.query('SELECT COUNT(*) FROM individual_entrepreneurs');
    const fsuCount = await this.pool.query('SELECT COUNT(*) FROM public_associations');

    const uoActive = await this.pool.query(
      'SELECT COUNT(*) FROM legal_entities WHERE stan = $1',
      ['зареєстровано']
    );
    const fopActive = await this.pool.query(
      'SELECT COUNT(*) FROM individual_entrepreneurs WHERE stan = $1',
      ['зареєстровано']
    );
    const fsuActive = await this.pool.query(
      'SELECT COUNT(*) FROM public_associations WHERE stan = $1',
      ['зареєстровано']
    );

    return {
      totalEntities: {
        legalEntities: parseInt(uoCount.rows[0].count),
        individualEntrepreneurs: parseInt(fopCount.rows[0].count),
        publicAssociations: parseInt(fsuCount.rows[0].count),
        total:
          parseInt(uoCount.rows[0].count) +
          parseInt(fopCount.rows[0].count) +
          parseInt(fsuCount.rows[0].count),
      },
      activeEntities: {
        legalEntities: parseInt(uoActive.rows[0].count),
        individualEntrepreneurs: parseInt(fopActive.rows[0].count),
        publicAssociations: parseInt(fsuActive.rows[0].count),
        total:
          parseInt(uoActive.rows[0].count) +
          parseInt(fopActive.rows[0].count) +
          parseInt(fsuActive.rows[0].count),
      },
    };
  }

  /**
   * Get approximate record counts from all registry tables (fast, uses pg_stat)
   */
  private async getRegistrySummary(): Promise<{ registry: string; records: number }[]> {
    const result = await this.pool.query(`
      SELECT relname, n_live_tup as count
      FROM pg_stat_user_tables
      WHERE relname IN ('legal_entities', 'individual_entrepreneurs', 'public_associations')
      ORDER BY relname
    `);
    return result.rows.map((r: any) => ({ registry: r.relname, records: parseInt(r.count) }));
  }

  private async findEntityType(record: string): Promise<'UO' | 'FOP' | 'FSU' | null> {
    const uoResult = await this.pool.query(
      'SELECT 1 FROM legal_entities WHERE record = $1',
      [record]
    );
    if (uoResult.rows.length > 0) return 'UO';

    const fopResult = await this.pool.query(
      'SELECT 1 FROM individual_entrepreneurs WHERE record = $1',
      [record]
    );
    if (fopResult.rows.length > 0) return 'FOP';

    const fsuResult = await this.pool.query(
      'SELECT 1 FROM public_associations WHERE record = $1',
      [record]
    );
    if (fsuResult.rows.length > 0) return 'FSU';

    return null;
  }
}

// Zod schemas for validation
export const SearchEntitiesSchema = z.object({
  query: z.string().optional(),
  edrpou: z.string().optional(),
  record: z.string().optional(),
  entityType: z.enum(['UO', 'FOP', 'FSU', 'ALL']).optional(),
  stan: z.string().optional(),
  limit: z.number().min(1).max(100).optional(),
  offset: z.number().min(0).optional(),
});

export const GetEntityDetailsSchema = z.object({
  record: z.string(),
  entityType: z.enum(['UO', 'FOP', 'FSU']).optional(),
});

export const SearchBeneficiariesSchema = z.object({
  query: z.string(),
  limit: z.number().min(1).max(100).optional(),
});

export const GetByEdrpouSchema = z.object({
  edrpou: z.string(),
});
