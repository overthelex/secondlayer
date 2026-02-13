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
   * Generate date range for the last week
   */
  private generateDateRange(startDate: string, endDate: string): string[] {
    const dates: string[] = [];
    const start = new Date(startDate);
    const end = new Date(endDate);

    for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
      dates.push(d.toISOString().split('T')[0]);
    }

    return dates;
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
   * Sync bills for a specific date
   */
  private async syncBillsForDate(date: string): Promise<number> {
    try {
      logger.info('Syncing bills', { date });

      // Search for bills registered on this date
      const result = await this.billService.searchBills({
        query: '*',
        date_from: date,
        date_to: date,
        limit: 1000,
      });

      logger.info('Bills synced', { date, count: result.total });
      return result.total;
    } catch (error: any) {
      logger.error('Failed to sync bills', { date, error: error.message });
      return 0;
    }
  }

  /**
   * Sync voting records for a specific date
   */
  private async syncVotingForDate(date: string): Promise<number> {
    try {
      logger.info('Syncing voting records', { date });

      // Get list of deputies to analyze their voting
      const deputies = await this.db.query(
        'SELECT rada_id, short_name FROM deputies WHERE active = true LIMIT 50'
      );

      let totalVotes = 0;
      for (const deputy of deputies.rows) {
        try {
          const result = await this.votingService.analyzeVotingRecord({
            deputy_name: deputy.short_name,
            date_from: date,
            date_to: date,
          });

          if (result.total_votes) {
            totalVotes += result.total_votes;
          }
        } catch (error: any) {
          // Continue with next deputy
          logger.debug('No voting data for deputy', {
            deputy: deputy.short_name,
            date,
          });
        }
      }

      logger.info('Voting records synced', { date, count: totalVotes });
      return totalVotes;
    } catch (error: any) {
      logger.error('Failed to sync voting records', { date, error: error.message });
      return 0;
    }
  }

  /**
   * Sync data for a single date
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
      // Sync bills for this date
      stats.bills = await this.syncBillsForDate(date);
    } catch (error: any) {
      stats.errors.push(`Bills: ${error.message}`);
    }

    try {
      // Sync voting records (only if we have deputies)
      const deputyCount = await this.db.query('SELECT COUNT(*) FROM deputies');
      if (parseInt(deputyCount.rows[0].count) > 0) {
        stats.votingRecords = await this.syncVotingForDate(date);
      }
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
      console.log('\n🔄 Step 1/2: Syncing all deputies...\n');
      const deputyCount = await this.syncAllDeputies();
      console.log(`✅ Synced ${deputyCount} deputies\n`);

      // Step 2: Generate date range
      const dates = this.generateDateRange(startDate, endDate);
      console.log(`🔄 Step 2/2: Syncing data for ${dates.length} days in ${this.concurrency} parallel threads...\n`);

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

      let totalBills = 0;
      let totalVoting = 0;
      let totalErrors = 0;

      console.log('Date       | Bills | Voting | Duration | Status');
      console.log('-'.repeat(70));

      for (const stat of results) {
        totalBills += stat.bills;
        totalVoting += stat.votingRecords;
        totalErrors += stat.errors.length;

        const status = stat.errors.length > 0 ? '⚠️  ' : '✅ ';
        const duration = (stat.duration / 1000).toFixed(1);

        console.log(
          `${stat.date} | ${stat.bills.toString().padStart(5)} | ${stat.votingRecords
            .toString()
            .padStart(6)} | ${duration.padStart(6)}s | ${status}`
        );

        if (stat.errors.length > 0) {
          console.log(`  Errors: ${stat.errors.join(', ')}`);
        }
      }

      console.log('-'.repeat(70));
      console.log(`Total      | ${totalBills.toString().padStart(5)} | ${totalVoting.toString().padStart(6)} |`);
      console.log('');
      console.log(`👥 Deputies synced:      ${deputyCount}`);
      console.log(`📄 Bills synced:         ${totalBills}`);
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
