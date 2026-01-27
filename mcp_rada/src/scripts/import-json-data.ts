/**
 * Import RADA data from existing JSON files
 * Usage: node dist/scripts/import-json-data.js <json-file-path>
 */

import { Database } from '../database/database';
import { logger } from '../utils/logger';
import { v4 as uuidv4 } from 'uuid';
import * as fs from 'fs';
import * as path from 'path';

interface RawDeputy {
  id?: string | number;
  rada_id?: string | number;
  full_name?: string;
  name?: string;
  firstname?: string;
  lastname?: string;
  patronymic?: string;
  sex?: string | number;
  gender?: number;
  region_name?: string;
  region_id?: number;
  okrug?: string;
  photo?: string;
  active_mps?: boolean;
  convocation?: number;
  current_fr_name?: string;
  current_fr_id?: string | number;
  main_komitet_name?: string;
  main_komitet_id?: string | number;
  main_komitet_role?: string;
  post_frs?: any[];
  [key: string]: any;
}

class DataImporter {
  private db: Database;

  constructor() {
    this.db = new Database();
  }

  async importDeputies(jsonPath: string): Promise<number> {
    try {
      const fullPath = path.resolve(jsonPath);
      console.log(`\n📂 Reading file: ${fullPath}`);

      if (!fs.existsSync(fullPath)) {
        throw new Error(`File not found: ${fullPath}`);
      }

      const content = fs.readFileSync(fullPath, 'utf-8');
      const data = JSON.parse(content);

      // Extract deputies array based on file structure
      let deputies: RawDeputy[] = [];

      if (Array.isArray(data)) {
        deputies = data;
      } else if (data.mps && Array.isArray(data.mps)) {
        deputies = data.mps;
      } else if (data.deputies && Array.isArray(data.deputies)) {
        deputies = data.deputies;
      } else if (data.item && Array.isArray(data.item)) {
        deputies = data.item;
      } else {
        throw new Error('Could not find deputies array in JSON file');
      }

      console.log(`\n✅ Found ${deputies.length} deputies in file`);
      console.log(`\n🔄 Importing deputies into database...\n`);

      await this.db.connect();

      let imported = 0;
      let updated = 0;
      let errors = 0;

      for (const rawDeputy of deputies) {
        try {
          const id = uuidv4();
          const radaId = String(rawDeputy.rada_id || rawDeputy.id || '');

          // Build full name from components or use existing
          let fullName = rawDeputy.full_name || rawDeputy.name || '';
          if (!fullName && (rawDeputy.firstname || rawDeputy.lastname)) {
            const parts = [
              rawDeputy.lastname || '',
              rawDeputy.firstname || '',
              rawDeputy.patronymic || ''
            ].filter(p => p);
            fullName = parts.join(' ');
          }

          const shortName = rawDeputy.name || rawDeputy.short_name ||
            [rawDeputy.lastname, rawDeputy.firstname].filter(p => p).join(' ') ||
            fullName;

          if (!radaId || !fullName) {
            logger.warn('Skipping deputy without ID or name', {
              id: rawDeputy.id,
              rada_id: rawDeputy.rada_id,
              firstname: rawDeputy.firstname,
              lastname: rawDeputy.lastname
            });
            errors++;
            continue;
          }

          // Extract faction info from post_frs array
          let factionId = rawDeputy.current_fr_id || null;
          let factionName = rawDeputy.current_fr_name || null;
          let committeeId = rawDeputy.main_komitet_id || null;
          let committeeName = rawDeputy.main_komitet_name || null;
          let committeeRole = rawDeputy.main_komitet_role || null;

          if (!factionName && rawDeputy.post_frs && Array.isArray(rawDeputy.post_frs)) {
            const factionPost = rawDeputy.post_frs.find((p: any) => p.is_fr === 1);
            if (factionPost) {
              factionId = factionPost.fr_association_id || null;
              factionName = factionPost.association_name || null;
            }

            // Find committee membership
            const committeePost = rawDeputy.post_frs.find((p: any) =>
              p.type === 2 || (p.association_name && p.association_name.includes('Комітет'))
            );
            if (committeePost) {
              committeeId = committeePost.fr_association_id || null;
              committeeName = committeePost.association_name || null;
              committeeRole = committeePost.post_name || null;
            }
          }

          // Determine convocation (default to 9 for current)
          const convocation = rawDeputy.convocation || 9;

          // Check if deputy already exists
          const existing = await this.db.query(
            'SELECT id FROM deputies WHERE rada_id = $1',
            [radaId]
          );

          const cacheExpires = new Date(Date.now() + 604800 * 1000); // 7 days

          // Determine gender (1 = male, 2 = female in RADA data)
          const gender = rawDeputy.gender === 2 ? 'F' : rawDeputy.gender === 1 ? 'M' : rawDeputy.sex || null;

          if (existing.rows.length > 0) {
            // Update existing deputy
            await this.db.query(
              `UPDATE deputies SET
                full_name = $1,
                short_name = $2,
                convocation = $3,
                active = $4,
                faction_id = $5,
                faction_name = $6,
                committee_id = $7,
                committee_name = $8,
                committee_role = $9,
                gender = $10,
                region = $11,
                district = $12,
                photo_url = $13,
                metadata = $14,
                cache_expires_at = $15,
                last_synced = NOW(),
                updated_at = NOW()
              WHERE rada_id = $16`,
              [
                fullName,
                shortName,
                convocation,
                rawDeputy.active_mps !== false,
                factionId ? String(factionId) : null,
                factionName,
                committeeId ? String(committeeId) : null,
                committeeName,
                committeeRole,
                gender,
                rawDeputy.region_name || null,
                rawDeputy.okrug || rawDeputy.district_num ? String(rawDeputy.district_num) : null,
                rawDeputy.photo || null,
                JSON.stringify(rawDeputy),
                cacheExpires,
                radaId
              ]
            );
            updated++;
          } else {
            // Insert new deputy
            await this.db.query(
              `INSERT INTO deputies (
                id, rada_id, full_name, short_name, convocation, active,
                faction_id, faction_name, committee_id, committee_name, committee_role,
                gender, region, district, photo_url, metadata,
                cached_at, cache_expires_at, last_synced, created_at, updated_at
              ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, NOW(), $17, NOW(), NOW(), NOW())`,
              [
                id,
                radaId,
                fullName,
                shortName,
                convocation,
                rawDeputy.active_mps !== false,
                factionId ? String(factionId) : null,
                factionName,
                committeeId ? String(committeeId) : null,
                committeeName,
                committeeRole,
                gender,
                rawDeputy.region_name || null,
                rawDeputy.okrug || rawDeputy.district_num ? String(rawDeputy.district_num) : null,
                rawDeputy.photo || null,
                JSON.stringify(rawDeputy),
                cacheExpires
              ]
            );
            imported++;
          }

          // Progress indicator
          if ((imported + updated) % 50 === 0) {
            process.stdout.write(`  Processed: ${imported + updated}/${deputies.length}\r`);
          }
        } catch (error: any) {
          logger.error('Failed to import deputy', {
            radaId: rawDeputy.id,
            error: error.message
          });
          errors++;
        }
      }

      console.log(`\n`);
      console.log('═'.repeat(70));
      console.log('📊 IMPORT SUMMARY');
      console.log('═'.repeat(70));
      console.log(`  ✅ New deputies imported:    ${imported}`);
      console.log(`  🔄 Existing deputies updated: ${updated}`);
      console.log(`  ❌ Errors:                    ${errors}`);
      console.log(`  📊 Total processed:           ${imported + updated}`);
      console.log('═'.repeat(70));

      return imported + updated;
    } catch (error: any) {
      logger.error('Import failed', { error: error.message });
      throw error;
    }
  }

  async close() {
    await this.db.close();
  }
}

async function main() {
  const args = process.argv.slice(2);

  if (args.length === 0 || args.includes('--help') || args.includes('-h')) {
    console.log(`
╔══════════════════════════════════════════════════════════════════════════════╗
║              🇺🇦 RADA Data Importer                                          ║
╚══════════════════════════════════════════════════════════════════════════════╝

USAGE:
  node dist/scripts/import-json-data.js <json-file-path>

EXAMPLES:
  # Import deputies from mps_skl9.json
  node dist/scripts/import-json-data.js /path/to/mps_skl9.json

  # Import deputies from deputies.json
  node dist/scripts/import-json-data.js /path/to/deputies.json

SUPPORTED FORMATS:
  - Array of deputies: [...deputies...]
  - Object with mps field: { mps: [...deputies...] }
  - Object with deputies field: { deputies: [...deputies...] }
  - Object with item field: { item: [...deputies...] }

NOTES:
  - Script automatically detects existing deputies and updates them
  - Cache expires after 7 days
  - Metadata is stored in JSONB format for future queries
`);
    return;
  }

  const jsonPath = args[0];
  const importer = new DataImporter();

  try {
    const count = await importer.importDeputies(jsonPath);
    console.log(`\n✅ Import completed successfully! Processed ${count} deputies.\n`);
    process.exit(0);
  } catch (error: any) {
    console.error(`\n❌ Import failed: ${error.message}\n`);
    process.exit(1);
  } finally {
    await importer.close();
  }
}

if (require.main === module) {
  main();
}

export { DataImporter };
