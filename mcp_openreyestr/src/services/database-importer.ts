import { createHash } from 'crypto';
import { Pool, PoolClient } from 'pg';
import { ParsedUOEntity, ParsedFOPEntity, ParsedFSUEntity } from './xml-parser.js';
import { EntityValidator, ValidationResult } from './entity-validator.js';

export interface ImportStats {
  imported: number;
  skipped: number;
  errors: number;
  unchanged: number;
}

export class DatabaseImporter {
  private pool: Pool;
  private validator: EntityValidator | null;
  private diffMode: boolean;

  constructor(pool: Pool, options: { validate?: boolean; diffMode?: boolean } = {}) {
    this.pool = pool;
    this.validator = options.validate !== false ? new EntityValidator() : null;
    this.diffMode = options.diffMode ?? false;
  }

  getValidator(): EntityValidator | null {
    return this.validator;
  }

  async importUOEntities(entities: ParsedUOEntity[], batchSize?: number): Promise<ImportStats> {
    const size = batchSize ?? parseInt(process.env.IMPORT_BATCH_SIZE || '500');
    const stats: ImportStats = { imported: 0, skipped: 0, errors: 0, unchanged: 0 };

    for (let i = 0; i < entities.length; i += size) {
      const batch = entities.slice(i, i + size);
      const client = await this.pool.connect();

      try {
        await client.query('BEGIN');

        for (let j = 0; j < batch.length; j++) {
          const entity = batch[j];
          const savepointName = `sp_${j}`;

          // Validate
          if (this.validator) {
            const result = this.validator.validateUO(entity);
            if (!result.valid) {
              if (this.validator.skipInvalid) {
                stats.skipped++;
                continue;
              }
              throw new Error(`Validation failed for ${entity.record}: ${result.errors.join(', ')}`);
            }
          }

          try {
            await client.query(`SAVEPOINT ${savepointName}`);

            // Hash-based change detection
            if (this.diffMode) {
              const hash = this.computeUOHash(entity);
              const existing = await client.query(
                'SELECT content_hash FROM legal_entities WHERE record = $1', [entity.record]
              );
              if (existing.rows.length > 0 && existing.rows[0].content_hash === hash) {
                stats.unchanged++;
                await client.query(`RELEASE SAVEPOINT ${savepointName}`);
                continue;
              }
              await this.importSingleUO(client, entity, hash);
            } else {
              await this.importSingleUO(client, entity);
            }

            await client.query(`RELEASE SAVEPOINT ${savepointName}`);
            stats.imported++;
          } catch (error) {
            stats.errors++;
            await client.query(`ROLLBACK TO SAVEPOINT ${savepointName}`);
            console.error(`Error importing UO entity ${entity.record}:`, error);
          }
        }

        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK');
        console.error('Batch import failed:', error);
        throw error;
      } finally {
        client.release();
      }
    }

    return stats;
  }

  async importFOPEntities(entities: ParsedFOPEntity[], batchSize?: number): Promise<ImportStats> {
    const size = batchSize ?? parseInt(process.env.IMPORT_BATCH_SIZE || '500');
    const stats: ImportStats = { imported: 0, skipped: 0, errors: 0, unchanged: 0 };

    for (let i = 0; i < entities.length; i += size) {
      const batch = entities.slice(i, i + size);
      const client = await this.pool.connect();

      try {
        await client.query('BEGIN');

        for (let j = 0; j < batch.length; j++) {
          const entity = batch[j];
          const savepointName = `sp_${j}`;

          if (this.validator) {
            const result = this.validator.validateFOP(entity);
            if (!result.valid) {
              if (this.validator.skipInvalid) {
                stats.skipped++;
                continue;
              }
              throw new Error(`Validation failed for ${entity.record}: ${result.errors.join(', ')}`);
            }
          }

          try {
            await client.query(`SAVEPOINT ${savepointName}`);

            if (this.diffMode) {
              const hash = this.computeFOPHash(entity);
              const existing = await client.query(
                'SELECT content_hash FROM individual_entrepreneurs WHERE record = $1', [entity.record]
              );
              if (existing.rows.length > 0 && existing.rows[0].content_hash === hash) {
                stats.unchanged++;
                await client.query(`RELEASE SAVEPOINT ${savepointName}`);
                continue;
              }
              await this.importSingleFOP(client, entity, hash);
            } else {
              await this.importSingleFOP(client, entity);
            }

            await client.query(`RELEASE SAVEPOINT ${savepointName}`);
            stats.imported++;
          } catch (error) {
            stats.errors++;
            await client.query(`ROLLBACK TO SAVEPOINT ${savepointName}`);
            console.error(`Error importing FOP entity ${entity.record}:`, error);
          }
        }

        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK');
        console.error('Batch import failed:', error);
        throw error;
      } finally {
        client.release();
      }
    }

    return stats;
  }

  async importFSUEntities(entities: ParsedFSUEntity[], batchSize?: number): Promise<ImportStats> {
    const size = batchSize ?? parseInt(process.env.IMPORT_BATCH_SIZE || '500');
    const stats: ImportStats = { imported: 0, skipped: 0, errors: 0, unchanged: 0 };

    for (let i = 0; i < entities.length; i += size) {
      const batch = entities.slice(i, i + size);
      const client = await this.pool.connect();

      try {
        await client.query('BEGIN');

        for (let j = 0; j < batch.length; j++) {
          const entity = batch[j];
          const savepointName = `sp_${j}`;

          if (this.validator) {
            const result = this.validator.validateFSU(entity);
            if (!result.valid) {
              if (this.validator.skipInvalid) {
                stats.skipped++;
                continue;
              }
              throw new Error(`Validation failed for ${entity.record}: ${result.errors.join(', ')}`);
            }
          }

          try {
            await client.query(`SAVEPOINT ${savepointName}`);

            if (this.diffMode) {
              const hash = this.computeFSUHash(entity);
              const existing = await client.query(
                'SELECT content_hash FROM public_associations WHERE record = $1', [entity.record]
              );
              if (existing.rows.length > 0 && existing.rows[0].content_hash === hash) {
                stats.unchanged++;
                await client.query(`RELEASE SAVEPOINT ${savepointName}`);
                continue;
              }
              await this.importSingleFSU(client, entity, hash);
            } else {
              await this.importSingleFSU(client, entity);
            }

            await client.query(`RELEASE SAVEPOINT ${savepointName}`);
            stats.imported++;
          } catch (error) {
            stats.errors++;
            await client.query(`ROLLBACK TO SAVEPOINT ${savepointName}`);
            console.error(`Error importing FSU entity ${entity.record}:`, error);
          }
        }

        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK');
        console.error('Batch import failed:', error);
        throw error;
      } finally {
        client.release();
      }
    }

    return stats;
  }

  // --- Hash computation ---

  private computeUOHash(entity: ParsedUOEntity): string {
    const data = JSON.stringify({
      n: entity.name, sn: entity.short_name, e: entity.edrpou, o: entity.opf,
      s: entity.stan, ac: entity.authorized_capital, r: entity.registration,
      ti: entity.terminated_info, f: entity.founders?.length,
      b: entity.beneficiaries?.length, sg: entity.signers?.length,
    });
    return createHash('md5').update(data).digest('hex');
  }

  private computeFOPHash(entity: ParsedFOPEntity): string {
    const data = JSON.stringify({
      n: entity.name, s: entity.stan, f: entity.farmer, em: entity.estate_manager,
      r: entity.registration, ti: entity.terminated_info,
    });
    return createHash('md5').update(data).digest('hex');
  }

  private computeFSUHash(entity: ParsedFSUEntity): string {
    const data = JSON.stringify({
      n: entity.name, sn: entity.short_name, e: entity.edrpou, ts: entity.type_subject,
      tb: entity.type_branch, s: entity.stan, r: entity.registration,
      ti: entity.terminated_info, f: entity.founders?.length,
    });
    return createHash('md5').update(data).digest('hex');
  }

  // --- Single entity importers with multi-row INSERTs for related tables ---

  private async importSingleUO(client: PoolClient, entity: ParsedUOEntity, contentHash?: string): Promise<void> {
    // Insert main entity
    await client.query(
      `INSERT INTO legal_entities (
        record, edrpou, name, short_name, opf, stan,
        authorized_capital, founding_document_num, purpose,
        superior_management, statute, registration, managing_paper,
        terminated_info, termination_cancel_info${contentHash ? ', content_hash' : ''}
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15${contentHash ? ', $16' : ''})
      ON CONFLICT (record) DO UPDATE SET
        edrpou = EXCLUDED.edrpou,
        name = EXCLUDED.name,
        short_name = EXCLUDED.short_name,
        opf = EXCLUDED.opf,
        stan = EXCLUDED.stan,
        authorized_capital = EXCLUDED.authorized_capital,
        founding_document_num = EXCLUDED.founding_document_num,
        purpose = EXCLUDED.purpose,
        superior_management = EXCLUDED.superior_management,
        statute = EXCLUDED.statute,
        registration = EXCLUDED.registration,
        managing_paper = EXCLUDED.managing_paper,
        terminated_info = EXCLUDED.terminated_info,
        termination_cancel_info = EXCLUDED.termination_cancel_info,
        ${contentHash ? 'content_hash = EXCLUDED.content_hash,' : ''}
        updated_at = CURRENT_TIMESTAMP`,
      [
        entity.record,
        entity.edrpou,
        entity.name,
        entity.short_name,
        entity.opf,
        entity.stan,
        entity.authorized_capital ? parseFloat(entity.authorized_capital.replace(',', '.')) : null,
        entity.founding_document_num,
        entity.purpose,
        entity.superior_management,
        entity.statute,
        entity.registration,
        entity.managing_paper,
        entity.terminated_info,
        entity.termination_cancel_info,
        ...(contentHash ? [contentHash] : []),
      ]
    );

    // Delete existing related records for this entity
    await client.query('DELETE FROM founders WHERE entity_type = $1 AND entity_record = $2', ['UO', entity.record]);
    await client.query('DELETE FROM beneficiaries WHERE entity_type = $1 AND entity_record = $2', ['UO', entity.record]);
    await client.query('DELETE FROM signers WHERE entity_type = $1 AND entity_record = $2', ['UO', entity.record]);
    await client.query('DELETE FROM members WHERE entity_record = $1', [entity.record]);
    await client.query('DELETE FROM branches WHERE parent_record = $1', [entity.record]);
    await client.query('DELETE FROM predecessors WHERE entity_type = $1 AND entity_record = $2', ['UO', entity.record]);
    await client.query('DELETE FROM assignees WHERE entity_record = $1', [entity.record]);
    await client.query('DELETE FROM executive_power WHERE entity_record = $1', [entity.record]);
    await client.query('DELETE FROM termination_started WHERE entity_type = $1 AND entity_record = $2', ['UO', entity.record]);
    await client.query('DELETE FROM bankruptcy_info WHERE entity_record = $1', [entity.record]);
    await client.query('DELETE FROM exchange_data WHERE entity_type = $1 AND entity_record = $2', ['UO', entity.record]);

    // Multi-row INSERTs for related tables
    if (entity.founders && entity.founders.length > 0) {
      await this.bulkInsertSimple(client, 'founders', ['entity_type', 'entity_record', 'founder_info'],
        entity.founders.map(f => ['UO', entity.record, f]));
    }

    if (entity.beneficiaries && entity.beneficiaries.length > 0) {
      await this.bulkInsertSimple(client, 'beneficiaries', ['entity_type', 'entity_record', 'beneficiary_info'],
        entity.beneficiaries.map(b => ['UO', entity.record, b]));
    }

    if (entity.signers && entity.signers.length > 0) {
      await this.bulkInsertSimple(client, 'signers', ['entity_type', 'entity_record', 'signer_info'],
        entity.signers.map(s => ['UO', entity.record, s]));
    }

    if (entity.members && entity.members.length > 0) {
      await this.bulkInsertSimple(client, 'members', ['entity_record', 'member_info'],
        entity.members.map(m => [entity.record, m]));
    }

    if (entity.branches && entity.branches.length > 0) {
      await this.bulkInsertSimple(client, 'branches',
        ['parent_record', 'code', 'name', 'signer', 'create_date'],
        entity.branches.map(b => [entity.record, b.code, b.name, b.signer, b.create_date]));
    }

    if (entity.predecessors && entity.predecessors.length > 0) {
      await this.bulkInsertSimple(client, 'predecessors',
        ['entity_type', 'entity_record', 'predecessor_name', 'predecessor_code'],
        entity.predecessors.map(p => ['UO', entity.record, p.name, p.code]));
    }

    if (entity.assignees && entity.assignees.length > 0) {
      await this.bulkInsertSimple(client, 'assignees',
        ['entity_record', 'assignee_name', 'assignee_code'],
        entity.assignees.map(a => [entity.record, a.name, a.code]));
    }

    if (entity.executive_power) {
      await client.query(
        'INSERT INTO executive_power (entity_record, name, code) VALUES ($1, $2, $3)',
        [entity.record, entity.executive_power.name, entity.executive_power.code]
      );
    }

    if (entity.termination_started) {
      await client.query(
        'INSERT INTO termination_started (entity_type, entity_record, op_date, reason, sbj_state, signer_name, creditor_req_end_date) VALUES ($1, $2, $3, $4, $5, $6, $7)',
        ['UO', entity.record, entity.termination_started.op_date, entity.termination_started.reason,
         entity.termination_started.sbj_state, entity.termination_started.signer_name,
         entity.termination_started.creditor_req_end_date]
      );
    }

    if (entity.bankruptcy_info) {
      await client.query(
        'INSERT INTO bankruptcy_info (entity_record, op_date, reason, sbj_state, head_name) VALUES ($1, $2, $3, $4, $5)',
        [entity.record, entity.bankruptcy_info.op_date, entity.bankruptcy_info.reason,
         entity.bankruptcy_info.sbj_state, entity.bankruptcy_info.head_name]
      );
    }

    if (entity.exchange_data && entity.exchange_data.length > 0) {
      await this.bulkInsertSimple(client, 'exchange_data',
        ['entity_type', 'entity_record', 'tax_payer_type', 'start_date', 'start_num', 'end_date', 'end_num'],
        entity.exchange_data.map(e => ['UO', entity.record, e.tax_payer_type, e.start_date, e.start_num, e.end_date, e.end_num]));
    }
  }

  private async importSingleFOP(client: PoolClient, entity: ParsedFOPEntity, contentHash?: string): Promise<void> {
    // Skip entities without required name field
    if (!entity.name) {
      return;
    }
    // Insert main entity
    await client.query(
      `INSERT INTO individual_entrepreneurs (
        record, name, stan, farmer, estate_manager, registration,
        terminated_info, termination_cancel_info${contentHash ? ', content_hash' : ''}
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8${contentHash ? ', $9' : ''})
      ON CONFLICT (record) DO UPDATE SET
        name = EXCLUDED.name,
        stan = EXCLUDED.stan,
        farmer = EXCLUDED.farmer,
        estate_manager = EXCLUDED.estate_manager,
        registration = EXCLUDED.registration,
        terminated_info = EXCLUDED.terminated_info,
        termination_cancel_info = EXCLUDED.termination_cancel_info,
        ${contentHash ? 'content_hash = EXCLUDED.content_hash,' : ''}
        updated_at = CURRENT_TIMESTAMP`,
      [
        entity.record,
        entity.name,
        entity.stan,
        entity.farmer,
        entity.estate_manager,
        entity.registration,
        entity.terminated_info,
        entity.termination_cancel_info,
        ...(contentHash ? [contentHash] : []),
      ]
    );

    // Delete existing exchange data
    await client.query('DELETE FROM exchange_data WHERE entity_type = $1 AND entity_record = $2', ['FOP', entity.record]);

    if (entity.exchange_data && entity.exchange_data.length > 0) {
      await this.bulkInsertSimple(client, 'exchange_data',
        ['entity_type', 'entity_record', 'tax_payer_type', 'start_date', 'start_num', 'end_date', 'end_num'],
        entity.exchange_data.map(e => ['FOP', entity.record, e.tax_payer_type, e.start_date, e.start_num, e.end_date, e.end_num]));
    }
  }

  private async importSingleFSU(client: PoolClient, entity: ParsedFSUEntity, contentHash?: string): Promise<void> {
    // Insert main entity
    await client.query(
      `INSERT INTO public_associations (
        record, edrpou, name, short_name, type_subject, type_branch,
        stan, founding_document, registration, terminated_info, termination_cancel_info${contentHash ? ', content_hash' : ''}
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11${contentHash ? ', $12' : ''})
      ON CONFLICT (record) DO UPDATE SET
        edrpou = EXCLUDED.edrpou,
        name = EXCLUDED.name,
        short_name = EXCLUDED.short_name,
        type_subject = EXCLUDED.type_subject,
        type_branch = EXCLUDED.type_branch,
        stan = EXCLUDED.stan,
        founding_document = EXCLUDED.founding_document,
        registration = EXCLUDED.registration,
        terminated_info = EXCLUDED.terminated_info,
        termination_cancel_info = EXCLUDED.termination_cancel_info,
        ${contentHash ? 'content_hash = EXCLUDED.content_hash,' : ''}
        updated_at = CURRENT_TIMESTAMP`,
      [
        entity.record,
        entity.edrpou,
        entity.name,
        entity.short_name,
        entity.type_subject,
        entity.type_branch,
        entity.stan,
        entity.founding_document,
        entity.registration,
        entity.terminated_info,
        entity.termination_cancel_info,
        ...(contentHash ? [contentHash] : []),
      ]
    );

    // Delete existing related records
    await client.query('DELETE FROM founders WHERE entity_type = $1 AND entity_record = $2', ['FSU', entity.record]);
    await client.query('DELETE FROM beneficiaries WHERE entity_type = $1 AND entity_record = $2', ['FSU', entity.record]);
    await client.query('DELETE FROM signers WHERE entity_type = $1 AND entity_record = $2', ['FSU', entity.record]);
    await client.query('DELETE FROM predecessors WHERE entity_type = $1 AND entity_record = $2', ['FSU', entity.record]);
    await client.query('DELETE FROM termination_started WHERE entity_type = $1 AND entity_record = $2', ['FSU', entity.record]);
    await client.query('DELETE FROM exchange_data WHERE entity_type = $1 AND entity_record = $2', ['FSU', entity.record]);

    // Multi-row INSERTs for related tables
    if (entity.founders && entity.founders.length > 0) {
      await this.bulkInsertSimple(client, 'founders', ['entity_type', 'entity_record', 'founder_info'],
        entity.founders.map(f => ['FSU', entity.record, f]));
    }

    if (entity.beneficiaries && entity.beneficiaries.length > 0) {
      await this.bulkInsertSimple(client, 'beneficiaries', ['entity_type', 'entity_record', 'beneficiary_info'],
        entity.beneficiaries.map(b => ['FSU', entity.record, b]));
    }

    if (entity.signers && entity.signers.length > 0) {
      await this.bulkInsertSimple(client, 'signers', ['entity_type', 'entity_record', 'signer_info'],
        entity.signers.map(s => ['FSU', entity.record, s]));
    }

    if (entity.predecessors && entity.predecessors.length > 0) {
      await this.bulkInsertSimple(client, 'predecessors',
        ['entity_type', 'entity_record', 'predecessor_name', 'predecessor_code'],
        entity.predecessors.map(p => ['FSU', entity.record, p.name, p.code]));
    }

    if (entity.termination_started) {
      await client.query(
        'INSERT INTO termination_started (entity_type, entity_record, op_date, reason, sbj_state, signer_name, creditor_req_end_date) VALUES ($1, $2, $3, $4, $5, $6, $7)',
        ['FSU', entity.record, entity.termination_started.op_date, entity.termination_started.reason,
         entity.termination_started.sbj_state, entity.termination_started.signer_name,
         entity.termination_started.creditor_req_end_date]
      );
    }

    if (entity.exchange_data && entity.exchange_data.length > 0) {
      await this.bulkInsertSimple(client, 'exchange_data',
        ['entity_type', 'entity_record', 'tax_payer_type', 'start_date', 'start_num', 'end_date', 'end_num'],
        entity.exchange_data.map(e => ['FSU', entity.record, e.tax_payer_type, e.start_date, e.start_num, e.end_date, e.end_num]));
    }
  }

  /**
   * Bulk insert rows into a table using multi-row VALUES.
   * Builds: INSERT INTO table (col1, col2) VALUES ($1,$2), ($3,$4), ...
   */
  private async bulkInsertSimple(
    client: PoolClient,
    table: string,
    columns: string[],
    rows: (string | number | null | undefined)[][]
  ): Promise<void> {
    if (rows.length === 0) return;

    const colCount = columns.length;
    const valuePlaceholders: string[] = [];
    const params: (string | number | null | undefined)[] = [];

    for (let i = 0; i < rows.length; i++) {
      const placeholders = [];
      for (let j = 0; j < colCount; j++) {
        placeholders.push(`$${i * colCount + j + 1}`);
        params.push(rows[i][j]);
      }
      valuePlaceholders.push(`(${placeholders.join(',')})`);
    }

    await client.query(
      `INSERT INTO ${table} (${columns.join(',')}) VALUES ${valuePlaceholders.join(',')}`,
      params
    );
  }
}
