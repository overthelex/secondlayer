import { Pool, PoolClient } from 'pg';
import { ParsedUOEntity, ParsedFOPEntity, ParsedFSUEntity } from './xml-parser.js';

export class DatabaseImporter {
  private pool: Pool;

  constructor(pool: Pool) {
    this.pool = pool;
  }

  async importUOEntities(entities: ParsedUOEntity[], batchSize: number = 1000): Promise<void> {
    let imported = 0;
    let errors = 0;

    for (let i = 0; i < entities.length; i += batchSize) {
      const batch = entities.slice(i, i + batchSize);
      const client = await this.pool.connect();

      try {
        await client.query('BEGIN');

        for (let j = 0; j < batch.length; j++) {
          const entity = batch[j];
          const savepointName = `sp_${j}`;

          try {
            await client.query(`SAVEPOINT ${savepointName}`);
            await this.importSingleUO(client, entity);
            await client.query(`RELEASE SAVEPOINT ${savepointName}`);
            imported++;
          } catch (error) {
            errors++;
            await client.query(`ROLLBACK TO SAVEPOINT ${savepointName}`);
            console.error(`Error importing UO entity ${entity.record}:`, error);
          }
        }

        await client.query('COMMIT');
        console.log(`Imported batch: ${imported} entities, ${errors} errors`);
      } catch (error) {
        await client.query('ROLLBACK');
        console.error('Batch import failed:', error);
        throw error;
      } finally {
        client.release();
      }
    }

    console.log(`Total imported: ${imported} UO entities, ${errors} errors`);
  }

  async importFOPEntities(entities: ParsedFOPEntity[], batchSize: number = 1000): Promise<void> {
    let imported = 0;
    let errors = 0;

    for (let i = 0; i < entities.length; i += batchSize) {
      const batch = entities.slice(i, i + batchSize);
      const client = await this.pool.connect();

      try {
        await client.query('BEGIN');

        for (let j = 0; j < batch.length; j++) {
          const entity = batch[j];
          const savepointName = `sp_${j}`;

          try {
            await client.query(`SAVEPOINT ${savepointName}`);
            await this.importSingleFOP(client, entity);
            await client.query(`RELEASE SAVEPOINT ${savepointName}`);
            imported++;
          } catch (error) {
            errors++;
            await client.query(`ROLLBACK TO SAVEPOINT ${savepointName}`);
            console.error(`Error importing FOP entity ${entity.record}:`, error);
          }
        }

        await client.query('COMMIT');
        console.log(`Imported batch: ${imported} entities, ${errors} errors`);
      } catch (error) {
        await client.query('ROLLBACK');
        console.error('Batch import failed:', error);
        throw error;
      } finally {
        client.release();
      }
    }

    console.log(`Total imported: ${imported} FOP entities, ${errors} errors`);
  }

  async importFSUEntities(entities: ParsedFSUEntity[], batchSize: number = 1000): Promise<void> {
    let imported = 0;
    let errors = 0;

    for (let i = 0; i < entities.length; i += batchSize) {
      const batch = entities.slice(i, i + batchSize);
      const client = await this.pool.connect();

      try {
        await client.query('BEGIN');

        for (let j = 0; j < batch.length; j++) {
          const entity = batch[j];
          const savepointName = `sp_${j}`;

          try {
            await client.query(`SAVEPOINT ${savepointName}`);
            await this.importSingleFSU(client, entity);
            await client.query(`RELEASE SAVEPOINT ${savepointName}`);
            imported++;
          } catch (error) {
            errors++;
            await client.query(`ROLLBACK TO SAVEPOINT ${savepointName}`);
            console.error(`Error importing FSU entity ${entity.record}:`, error);
          }
        }

        await client.query('COMMIT');
        console.log(`Imported batch: ${imported} entities, ${errors} errors`);
      } catch (error) {
        await client.query('ROLLBACK');
        console.error('Batch import failed:', error);
        throw error;
      } finally {
        client.release();
      }
    }

    console.log(`Total imported: ${imported} FSU entities, ${errors} errors`);
  }

  private async importSingleUO(client: PoolClient, entity: ParsedUOEntity): Promise<void> {
    // Insert main entity
    await client.query(
      `INSERT INTO legal_entities (
        record, edrpou, name, short_name, opf, stan,
        authorized_capital, founding_document_num, purpose,
        superior_management, statute, registration, managing_paper,
        terminated_info, termination_cancel_info
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
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

    // Insert related records
    if (entity.founders) {
      for (const founder of entity.founders) {
        await client.query(
          'INSERT INTO founders (entity_type, entity_record, founder_info) VALUES ($1, $2, $3)',
          ['UO', entity.record, founder]
        );
      }
    }

    if (entity.beneficiaries) {
      for (const beneficiary of entity.beneficiaries) {
        await client.query(
          'INSERT INTO beneficiaries (entity_type, entity_record, beneficiary_info) VALUES ($1, $2, $3)',
          ['UO', entity.record, beneficiary]
        );
      }
    }

    if (entity.signers) {
      for (const signer of entity.signers) {
        await client.query(
          'INSERT INTO signers (entity_type, entity_record, signer_info) VALUES ($1, $2, $3)',
          ['UO', entity.record, signer]
        );
      }
    }

    if (entity.members) {
      for (const member of entity.members) {
        await client.query(
          'INSERT INTO members (entity_record, member_info) VALUES ($1, $2)',
          [entity.record, member]
        );
      }
    }

    if (entity.branches) {
      for (const branch of entity.branches) {
        await client.query(
          'INSERT INTO branches (parent_record, code, name, signer, create_date) VALUES ($1, $2, $3, $4, $5)',
          [entity.record, branch.code, branch.name, branch.signer, branch.create_date]
        );
      }
    }

    if (entity.predecessors) {
      for (const predecessor of entity.predecessors) {
        await client.query(
          'INSERT INTO predecessors (entity_type, entity_record, predecessor_name, predecessor_code) VALUES ($1, $2, $3, $4)',
          ['UO', entity.record, predecessor.name, predecessor.code]
        );
      }
    }

    if (entity.assignees) {
      for (const assignee of entity.assignees) {
        await client.query(
          'INSERT INTO assignees (entity_record, assignee_name, assignee_code) VALUES ($1, $2, $3)',
          [entity.record, assignee.name, assignee.code]
        );
      }
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

    if (entity.exchange_data) {
      for (const exchange of entity.exchange_data) {
        await client.query(
          'INSERT INTO exchange_data (entity_type, entity_record, tax_payer_type, start_date, start_num, end_date, end_num) VALUES ($1, $2, $3, $4, $5, $6, $7)',
          ['UO', entity.record, exchange.tax_payer_type, exchange.start_date,
           exchange.start_num, exchange.end_date, exchange.end_num]
        );
      }
    }
  }

  private async importSingleFOP(client: PoolClient, entity: ParsedFOPEntity): Promise<void> {
    // Insert main entity
    await client.query(
      `INSERT INTO individual_entrepreneurs (
        record, name, stan, farmer, estate_manager, registration,
        terminated_info, termination_cancel_info
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      ON CONFLICT (record) DO UPDATE SET
        name = EXCLUDED.name,
        stan = EXCLUDED.stan,
        farmer = EXCLUDED.farmer,
        estate_manager = EXCLUDED.estate_manager,
        registration = EXCLUDED.registration,
        terminated_info = EXCLUDED.terminated_info,
        termination_cancel_info = EXCLUDED.termination_cancel_info,
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
      ]
    );

    // Delete existing exchange data
    await client.query('DELETE FROM exchange_data WHERE entity_type = $1 AND entity_record = $2', ['FOP', entity.record]);

    // Insert exchange data
    if (entity.exchange_data) {
      for (const exchange of entity.exchange_data) {
        await client.query(
          'INSERT INTO exchange_data (entity_type, entity_record, tax_payer_type, start_date, start_num, end_date, end_num) VALUES ($1, $2, $3, $4, $5, $6, $7)',
          ['FOP', entity.record, exchange.tax_payer_type, exchange.start_date,
           exchange.start_num, exchange.end_date, exchange.end_num]
        );
      }
    }
  }

  private async importSingleFSU(client: PoolClient, entity: ParsedFSUEntity): Promise<void> {
    // Insert main entity
    await client.query(
      `INSERT INTO public_associations (
        record, edrpou, name, short_name, type_subject, type_branch,
        stan, founding_document, registration, terminated_info, termination_cancel_info
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
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
      ]
    );

    // Delete existing related records
    await client.query('DELETE FROM founders WHERE entity_type = $1 AND entity_record = $2', ['FSU', entity.record]);
    await client.query('DELETE FROM beneficiaries WHERE entity_type = $1 AND entity_record = $2', ['FSU', entity.record]);
    await client.query('DELETE FROM signers WHERE entity_type = $1 AND entity_record = $2', ['FSU', entity.record]);
    await client.query('DELETE FROM predecessors WHERE entity_type = $1 AND entity_record = $2', ['FSU', entity.record]);
    await client.query('DELETE FROM termination_started WHERE entity_type = $1 AND entity_record = $2', ['FSU', entity.record]);
    await client.query('DELETE FROM exchange_data WHERE entity_type = $1 AND entity_record = $2', ['FSU', entity.record]);

    // Insert related records
    if (entity.founders) {
      for (const founder of entity.founders) {
        await client.query(
          'INSERT INTO founders (entity_type, entity_record, founder_info) VALUES ($1, $2, $3)',
          ['FSU', entity.record, founder]
        );
      }
    }

    if (entity.beneficiaries) {
      for (const beneficiary of entity.beneficiaries) {
        await client.query(
          'INSERT INTO beneficiaries (entity_type, entity_record, beneficiary_info) VALUES ($1, $2, $3)',
          ['FSU', entity.record, beneficiary]
        );
      }
    }

    if (entity.signers) {
      for (const signer of entity.signers) {
        await client.query(
          'INSERT INTO signers (entity_type, entity_record, signer_info) VALUES ($1, $2, $3)',
          ['FSU', entity.record, signer]
        );
      }
    }

    if (entity.predecessors) {
      for (const predecessor of entity.predecessors) {
        await client.query(
          'INSERT INTO predecessors (entity_type, entity_record, predecessor_name, predecessor_code) VALUES ($1, $2, $3, $4)',
          ['FSU', entity.record, predecessor.name, predecessor.code]
        );
      }
    }

    if (entity.termination_started) {
      await client.query(
        'INSERT INTO termination_started (entity_type, entity_record, op_date, reason, sbj_state, signer_name, creditor_req_end_date) VALUES ($1, $2, $3, $4, $5, $6, $7)',
        ['FSU', entity.record, entity.termination_started.op_date, entity.termination_started.reason,
         entity.termination_started.sbj_state, entity.termination_started.signer_name,
         entity.termination_started.creditor_req_end_date]
      );
    }

    if (entity.exchange_data) {
      for (const exchange of entity.exchange_data) {
        await client.query(
          'INSERT INTO exchange_data (entity_type, entity_record, tax_payer_type, start_date, start_num, end_date, end_num) VALUES ($1, $2, $3, $4, $5, $6, $7)',
          ['FSU', entity.record, exchange.tax_payer_type, exchange.start_date,
           exchange.start_num, exchange.end_date, exchange.end_num]
        );
      }
    }
  }
}
