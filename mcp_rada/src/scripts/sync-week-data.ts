/**
 * Sync RADA data for the last week in parallel
 * Usage: node dist/scripts/sync-week-data.js
 */

import { Database } from '../database/database';
import { RadaAPIAdapter } from '../adapters/rada-api-adapter';
import { DeputyService } from '../services/deputy-service';
import { BillService } from '../services/bill-service';
import { VotingService } from '../services/voting-service';
import { logger } from '../utils/logger';
// import pLimit from 'p-limit'; // Not needed, using manual batching

interface SyncStats {
  date: string;
  deputies: number;
  bills: number;
  votingRecords: number;
  errors: string[];
  duration: number;
}

class WeekDataSyncer {
  private db: Database;
  private radaAdapter: RadaAPIAdapter;
  private deputyService: DeputyService;
  private billService: BillService;
  private votingService: VotingService;
  private concurrency: number;

  constructor(concurrency: number = 10) {
    this.db = new Database();
    this.radaAdapter = new RadaAPIAdapter();
    this.deputyService = new DeputyService(this.db, this.radaAdapter);
    this.billService = new BillService(this.db, this.radaAdapter);
    this.votingService = new VotingService(this.db, this.radaAdapter);
    this.concurrency = concurrency;
  }

  /**
   * Sync all deputies for convocation 9
   */
  private async syncAllDeputies(): Promise<number> {
    try {
      logger.info('Starting full deputy sync for convocation 9');
      const count = await this.deputyService.syncAllDeputies(9);
      logger.info('Deputy sync completed', { count });
      return count;
    } catch (error: any) {
      logger.error('Failed to sync deputies', { error: error.message });
      return 0;
    }
  }

  /**
   * Sync all bills from RADA API (full list for convocation 9)
   */
  private async syncAllBillsFromAPI(startDate: string, endDate: string): Promise<number> {
    try {
      logger.info('Fetching all bills from RADA API', { startDate, endDate });
      // syncAllBills fetches the full convocation bill list and upserts each one
      const count = await this.billService.syncAllBills(9);
      logger.info('Bills sync completed', { count });
      return count;
    } catch (error: any) {
      logger.error('Failed to sync bills from API', { error: error.message });
      return 0;
    }
  }

  /**
   * Sync voting records for a specific date by fetching from RADA API
   */
  private async syncVotingForDate(date: string): Promise<number> {
    try {
      logger.info('Syncing voting records from API', { date });

      // getVotingByDate fetches from RADA API and saves to DB
      const records = await this.votingService.getVotingByDate(date, 9);

      logger.info('Voting records synced', { date, count: records.length });
      return records.length;
    } catch (error: any) {
      // 404 is expected for dates with no plenary sessions
      if (error.message?.includes('404') || error.message?.includes('Not Found')) {
        logger.debug('No plenary session data for date', { date });
        return 0;
      }
      logger.error('Failed to sync voting records', { date, error: error.message });
      return 0;
    }
  }

  /**
   * Sync voting data for a single date
   */
  private async syncDateData(date: string): Promise<SyncStats> {
    const startTime = Date.now();
    const stats: SyncStats = {
      date,
      deputies: 0,
      bills: 0,
      votingRecords: 0,
      errors: [],
      duration: 0,
    };

    try {
      // Sync voting records for this date from RADA API
      stats.votingRecords = await this.syncVotingForDate(date);
    } catch (error: any) {
      stats.errors.push(`Voting: ${error.message}`);
    }

    stats.duration = Date.now() - startTime;
    return stats;
  }

  /**
   * Main sync method
   */
  async syncWeekData(startDate: string, endDate: string): Promise<void> {
    const overallStart = Date.now();

    try {
      // Connect to database
      await this.db.connect();
      logger.info('Database connected');

      // Step 1: Sync all deputies first (once for all dates)
      console.log('\n🔄 Step 1/3: Syncing all deputies...\n');
      const deputyCount = await this.syncAllDeputies();
      console.log(`✅ Synced ${deputyCount} deputies\n`);

      // Step 2: Sync all bills from RADA API (one big download, filtered by date range)
      console.log('🔄 Step 2/3: Syncing bills from RADA API...\n');
      const billCount = await this.syncAllBillsFromAPI(startDate, endDate);
      console.log(`✅ Synced ${billCount} bills\n`);

      // Step 3: Sync voting records — only for dates with actual plenary sessions
      console.log('🔄 Step 3/3: Fetching available session dates...\n');
      const allSessionDates = await this.radaAdapter.fetchAvailableSessionDates(9);
      const dates = allSessionDates.filter(d => d >= startDate && d <= endDate);
      console.log(`  Found ${dates.length} session days in range (of ${allSessionDates.length} total)\n`);
      console.log(`  Syncing voting data with ${this.concurrency} parallel threads...\n`);

      // Process dates in batches with concurrency limit
      const results: SyncStats[] = [];
      for (let i = 0; i < dates.length; i += this.concurrency) {
        const batch = dates.slice(i, i + this.concurrency);
        const batchResults = await Promise.all(
          batch.map((date) => this.syncDateData(date))
        );
        results.push(...batchResults);
      }

      // Print summary
      console.log('\n' + '='.repeat(70));
      console.log('📊 SYNC SUMMARY');
      console.log('='.repeat(70) + '\n');

      let totalVoting = 0;
      let totalErrors = 0;

      console.log('Date       | Voting | Duration | Status');
      console.log('-'.repeat(60));

      for (const stat of results) {
        totalVoting += stat.votingRecords;
        totalErrors += stat.errors.length;

        const status = stat.errors.length > 0 ? '⚠️  ' : '✅ ';
        const duration = (stat.duration / 1000).toFixed(1);

        // Only print dates that had voting records or errors
        if (stat.votingRecords > 0 || stat.errors.length > 0) {
          console.log(
            `${stat.date} | ${stat.votingRecords
              .toString()
              .padStart(6)} | ${duration.padStart(6)}s | ${status}`
          );

          if (stat.errors.length > 0) {
            console.log(`  Errors: ${stat.errors.join(', ')}`);
          }
        }
      }

      console.log('-'.repeat(60));
      console.log(`Total      | ${totalVoting.toString().padStart(6)} |`);
      console.log('');
      console.log(`👥 Deputies synced:      ${deputyCount}`);
      console.log(`📄 Bills synced:         ${billCount}`);
      console.log(`🗳️  Voting records:       ${totalVoting}`);
      console.log(`❌ Total errors:         ${totalErrors}`);
      console.log(`⏱️  Total time:           ${((Date.now() - overallStart) / 1000).toFixed(1)}s`);
      console.log('');
      console.log('✅ Week data sync completed!');
      console.log('='.repeat(70) + '\n');
    } catch (error: any) {
      logger.error('Fatal error during sync', { error: error.message });
      console.error('\n❌ Sync failed:', error.message);
      process.exit(1);
    } finally {
      await this.db.close();
    }
  }
}

// Main execution
async function main() {
  const startDate = process.env.START_DATE || '2026-01-20';
  const endDate = process.env.END_DATE || '2026-01-27';
  const concurrency = parseInt(process.env.CONCURRENCY || '10', 10);

  console.log('\n' + '='.repeat(70));
  console.log('🚀 RADA Week Data Sync');
  console.log('='.repeat(70));
  console.log(`📅 Date range:    ${startDate} to ${endDate}`);
  console.log(`🔀 Concurrency:   ${concurrency} parallel threads`);
  console.log('='.repeat(70) + '\n');

  const syncer = new WeekDataSyncer(concurrency);
  await syncer.syncWeekData(startDate, endDate);
}

// Run if called directly
if (require.main === module) {
  main().catch((error) => {
    console.error('Fatal error:', error);
    process.exit(1);
  });
}

export { WeekDataSyncer };
