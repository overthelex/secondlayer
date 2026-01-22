/**
 * EULA Service
 * Handles End User License Agreement acceptance tracking and document management
 */

import { Pool } from 'pg';
import fs from 'fs/promises';
import path from 'path';

export interface EULADocument {
  id: number;
  version: string;
  content: string;
  contentType: 'markdown' | 'html' | 'plain';
  isActive: boolean;
  createdAt: Date;
  effectiveDate: Date;
}

export interface EULAAcceptance {
  id: number;
  userId: number;
  eulaVersion: string;
  acceptedAt: Date;
  ipAddress?: string;
  userAgent?: string;
}

export interface UserManualSection {
  title: string;
  content: string;
  order: number;
}

export class EULAService {
  private pool: Pool;

  constructor(pool: Pool) {
    this.pool = pool;
  }

  /**
   * Get the currently active EULA document
   */
  async getActiveEULA(): Promise<EULADocument | null> {
    const result = await this.pool.query<EULADocument>(
      `SELECT id, version, content, content_type as "contentType",
              is_active as "isActive", created_at as "createdAt",
              effective_date as "effectiveDate"
       FROM eula_documents
       WHERE is_active = true
       ORDER BY effective_date DESC
       LIMIT 1`
    );

    return result.rows[0] || null;
  }

  /**
   * Get a specific EULA version
   */
  async getEULAByVersion(version: string): Promise<EULADocument | null> {
    const result = await this.pool.query<EULADocument>(
      `SELECT id, version, content, content_type as "contentType",
              is_active as "isActive", created_at as "createdAt",
              effective_date as "effectiveDate"
       FROM eula_documents
       WHERE version = $1`,
      [version]
    );

    return result.rows[0] || null;
  }

  /**
   * Check if a user has accepted the current EULA
   */
  async hasUserAcceptedEULA(userId: number, version?: string): Promise<boolean> {
    let query: string;
    let params: any[];

    if (version) {
      query = `
        SELECT COUNT(*) as count
        FROM eula_acceptances
        WHERE user_id = $1 AND eula_version = $2
      `;
      params = [userId, version];
    } else {
      // Check if user accepted the currently active EULA
      query = `
        SELECT COUNT(*) as count
        FROM eula_acceptances ea
        INNER JOIN eula_documents ed ON ea.eula_version = ed.version
        WHERE ea.user_id = $1 AND ed.is_active = true
      `;
      params = [userId];
    }

    const result = await this.pool.query<{ count: string }>(query, params);
    return parseInt(result.rows[0].count, 10) > 0;
  }

  /**
   * Record user's acceptance of EULA
   */
  async recordAcceptance(
    userId: number,
    version: string,
    ipAddress?: string,
    userAgent?: string
  ): Promise<EULAAcceptance> {
    const result = await this.pool.query<EULAAcceptance>(
      `INSERT INTO eula_acceptances (user_id, eula_version, ip_address, user_agent)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (user_id, eula_version) DO UPDATE
       SET accepted_at = CURRENT_TIMESTAMP,
           ip_address = EXCLUDED.ip_address,
           user_agent = EXCLUDED.user_agent
       RETURNING id, user_id as "userId", eula_version as "eulaVersion",
                 accepted_at as "acceptedAt", ip_address as "ipAddress",
                 user_agent as "userAgent"`,
      [userId, version, ipAddress, userAgent]
    );

    return result.rows[0];
  }

  /**
   * Get user's EULA acceptance history
   */
  async getUserAcceptances(userId: number): Promise<EULAAcceptance[]> {
    const result = await this.pool.query<EULAAcceptance>(
      `SELECT id, user_id as "userId", eula_version as "eulaVersion",
              accepted_at as "acceptedAt", ip_address as "ipAddress",
              user_agent as "userAgent"
       FROM eula_acceptances
       WHERE user_id = $1
       ORDER BY accepted_at DESC`,
      [userId]
    );

    return result.rows;
  }

  /**
   * Load EULA content from the EULA.txt file
   * Extracts the EULA section (section 3)
   */
  async loadEULAFromFile(): Promise<string> {
    try {
      const filePath = path.join(process.cwd(), '..', 'EULA.txt');
      const content = await fs.readFile(filePath, 'utf-8');

      // Extract EULA section (starts with "## 3. Ліцензійна угода кінцевого користувача")
      const eulaStart = content.indexOf('## 3. Ліцензійна угода кінцевого користувача');
      if (eulaStart === -1) {
        throw new Error('EULA section not found in file');
      }

      // Extract from EULA start to end of file (or next major section)
      const eulaContent = content.substring(eulaStart);

      return eulaContent.trim();
    } catch (error) {
      console.error('Error loading EULA from file:', error);
      throw new Error('Failed to load EULA content');
    }
  }

  /**
   * Load user manual content from the EULA.txt file
   * Extracts section 1 (User Manual)
   */
  async loadUserManualFromFile(): Promise<string> {
    try {
      const filePath = path.join(process.cwd(), '..', 'EULA.txt');
      const content = await fs.readFile(filePath, 'utf-8');

      // Extract user manual section (starts with "## 1. Руководство пользователя Lex")
      const manualStart = content.indexOf('## 1. Руководство пользователя Lex');
      const manualEnd = content.indexOf('## 2. Договір на використання системи Lex');

      if (manualStart === -1) {
        throw new Error('User manual section not found in file');
      }

      const manualContent = manualEnd !== -1
        ? content.substring(manualStart, manualEnd)
        : content.substring(manualStart);

      return manualContent.trim();
    } catch (error) {
      console.error('Error loading user manual from file:', error);
      throw new Error('Failed to load user manual content');
    }
  }

  /**
   * Load service agreement content from the EULA.txt file
   * Extracts section 2
   */
  async loadServiceAgreementFromFile(): Promise<string> {
    try {
      const filePath = path.join(process.cwd(), '..', 'EULA.txt');
      const content = await fs.readFile(filePath, 'utf-8');

      // Extract service agreement section
      const agreementStart = content.indexOf('## 2. Договір на використання системи Lex');
      const agreementEnd = content.indexOf('## 3. Ліцензійна угода кінцевого користувача');

      if (agreementStart === -1) {
        throw new Error('Service agreement section not found in file');
      }

      const agreementContent = agreementEnd !== -1
        ? content.substring(agreementStart, agreementEnd)
        : content.substring(agreementStart);

      return agreementContent.trim();
    } catch (error) {
      console.error('Error loading service agreement from file:', error);
      throw new Error('Failed to load service agreement content');
    }
  }

  /**
   * Update the EULA document in the database with content from file
   */
  async updateEULAFromFile(version: string = '1.0'): Promise<void> {
    const eulaContent = await this.loadEULAFromFile();

    await this.pool.query(
      `UPDATE eula_documents
       SET content = $1, content_type = 'markdown'
       WHERE version = $2`,
      [eulaContent, version]
    );
  }

  /**
   * Create a new EULA version
   */
  async createEULAVersion(
    version: string,
    content: string,
    contentType: 'markdown' | 'html' | 'plain' = 'markdown',
    setAsActive: boolean = false
  ): Promise<EULADocument> {
    // If setting as active, deactivate all other versions first
    if (setAsActive) {
      await this.pool.query('UPDATE eula_documents SET is_active = false');
    }

    const result = await this.pool.query<EULADocument>(
      `INSERT INTO eula_documents (version, content, content_type, is_active, effective_date)
       VALUES ($1, $2, $3, $4, CURRENT_TIMESTAMP)
       RETURNING id, version, content, content_type as "contentType",
                 is_active as "isActive", created_at as "createdAt",
                 effective_date as "effectiveDate"`,
      [version, content, contentType, setAsActive]
    );

    return result.rows[0];
  }

  /**
   * Get all legal documents (EULA, manual, agreement)
   */
  async getAllDocuments(): Promise<{
    eula: string;
    userManual: string;
    serviceAgreement: string;
  }> {
    const [eula, userManual, serviceAgreement] = await Promise.all([
      this.loadEULAFromFile(),
      this.loadUserManualFromFile(),
      this.loadServiceAgreementFromFile(),
    ]);

    return { eula, userManual, serviceAgreement };
  }
}
