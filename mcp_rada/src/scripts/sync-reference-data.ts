/**
 * Sync Reference Data Script
 * Downloads factions, committees, and deputy assistants from RADA API
 */

import dotenv from 'dotenv';
dotenv.config();

import { Database } from '../database/database';
import { RadaAPIAdapter } from '../adapters/rada-api-adapter';
import { FactionService } from '../services/faction-service';
import { CommitteeService } from '../services/committee-service';
import { DeputyService } from '../services/deputy-service';

async function main() {
  const convocation = parseInt(process.env.CONVOCATION || '9', 10);
  const syncAssistants = process.env.SYNC_ASSISTANTS !== 'false';
  const concurrency = parseInt(process.env.CONCURRENCY || '5', 10);

  console.log('\n' + '='.repeat(60));
  console.log('RADA Reference Data Sync');
  console.log('='.repeat(60));
  console.log(`Convocation: ${convocation}`);
  console.log(`Sync assistants: ${syncAssistants}`);
  console.log(`Concurrency: ${concurrency}`);
  console.log('');

  const db = new Database();
  const radaAdapter = new RadaAPIAdapter();
  const factionService = new FactionService(db, radaAdapter);
  const committeeService = new CommitteeService(db, radaAdapter);
  const deputyService = new DeputyService(db, radaAdapter);

  try {
    await db.connect();

    // 1. Sync factions
    console.log('Syncing factions...');
    const factionCount = await factionService.syncAllFactions(convocation);
    console.log(`  Factions synced: ${factionCount}`);

    // 2. Sync committees
    console.log('Syncing committees...');
    const committeeCount = await committeeService.syncAllCommittees(convocation);
    console.log(`  Committees synced: ${committeeCount}`);

    // 3. Bulk sync assistants
    let assistantCount = 0;
    if (syncAssistants) {
      console.log('Syncing deputy assistants...');

      // Get all deputies from DB
      const deputiesResult = await db.query(
        'SELECT rada_id FROM deputies WHERE convocation = $1',
        [convocation]
      );
      const deputies = deputiesResult.rows;
      console.log(`  Found ${deputies.length} deputies, fetching assistants...`);

      // Process in batches with concurrency limit
      for (let i = 0; i < deputies.length; i += concurrency) {
        const batch = deputies.slice(i, i + concurrency);
        const results = await Promise.allSettled(
          batch.map((d: any) => deputyService.getDeputyAssistants(d.rada_id, convocation))
        );

        for (const result of results) {
          if (result.status === 'fulfilled') {
            assistantCount += result.value.length;
          }
        }

        const progress = Math.min(i + concurrency, deputies.length);
        process.stdout.write(`  Progress: ${progress}/${deputies.length} deputies\r`);
      }
      console.log(`\n  Assistants synced: ${assistantCount}`);
    }

    // Summary
    console.log('\n' + '='.repeat(60));
    console.log('SYNC COMPLETE');
    console.log('='.repeat(60));
    console.log(`  Factions:   ${factionCount}`);
    console.log(`  Committees: ${committeeCount}`);
    if (syncAssistants) {
      console.log(`  Assistants: ${assistantCount}`);
    }
    console.log('');
  } catch (error) {
    console.error('Sync failed:', error);
    process.exit(1);
  } finally {
    await db.close();
  }
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
