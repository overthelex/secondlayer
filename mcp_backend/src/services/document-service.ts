import { Database } from '../database/database.js';
import { logger } from '../utils/logger.js';
import { v4 as uuidv4 } from 'uuid';
import { DocumentSection } from '../types/index.js';

export interface Document {
  id?: string;
  zakononline_id: string;
  type: string;
  title?: string;
  date?: Date | string;
  full_text?: string;
  full_text_html?: string;
  metadata?: any;
  created_at?: Date;
  updated_at?: Date;
}

export class DocumentService {
  constructor(private db: Database) {}

  /**
   * Save or update a document in the database
   * Uses UPSERT (INSERT ... ON CONFLICT UPDATE) to handle duplicates
   */
  async saveDocument(doc: Document): Promise<string> {
    try {
      const id = doc.id || uuidv4();
      
      const query = `
        INSERT INTO documents (
          id, zakononline_id, type, title, date, full_text, full_text_html, metadata, updated_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW())
        ON CONFLICT (zakononline_id) 
        DO UPDATE SET
          title = EXCLUDED.title,
          date = EXCLUDED.date,
          full_text = COALESCE(EXCLUDED.full_text, documents.full_text),
          full_text_html = COALESCE(EXCLUDED.full_text_html, documents.full_text_html),
          metadata = documents.metadata || EXCLUDED.metadata,
          updated_at = NOW()
        RETURNING id
      `;

      const result = await this.db.query(query, [
        id,
        doc.zakononline_id,
        doc.type,
        doc.title || null,
        doc.date || null,
        doc.full_text || null,
        doc.full_text_html || null,
        JSON.stringify(doc.metadata || {}),
      ]);

      const savedId = result.rows[0].id;
      
      logger.info('Document saved to database', {
        id: savedId,
        zakononline_id: doc.zakononline_id,
        type: doc.type,
        hasFullText: !!doc.full_text,
      });

      return savedId;
    } catch (error: any) {
      logger.error('Failed to save document:', {
        zakononline_id: doc.zakononline_id,
        error: error.message,
      });
      throw error;
    }
  }

  /**
   * Save multiple documents in a transaction
   */
  async saveDocumentsBatch(docs: Document[]): Promise<string[]> {
    return await this.db.transaction(async (client) => {
      const ids: string[] = [];

      for (const doc of docs) {
        const id = doc.id || uuidv4();
        
        const query = `
          INSERT INTO documents (
            id, zakononline_id, type, title, date, full_text, full_text_html, metadata, updated_at
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW())
          ON CONFLICT (zakononline_id) 
          DO UPDATE SET
            title = EXCLUDED.title,
            date = EXCLUDED.date,
            full_text = COALESCE(EXCLUDED.full_text, documents.full_text),
            full_text_html = COALESCE(EXCLUDED.full_text_html, documents.full_text_html),
            metadata = documents.metadata || EXCLUDED.metadata,
            updated_at = NOW()
          RETURNING id
        `;

        const result = await client.query(query, [
          id,
          doc.zakononline_id,
          doc.type,
          doc.title || null,
          doc.date || null,
          doc.full_text || null,
          doc.full_text_html || null,
          JSON.stringify(doc.metadata || {}),
        ]);

        ids.push(result.rows[0].id);
      }

      logger.info('Batch saved documents to database', {
        count: docs.length,
      });

      return ids;
    });
  }

  /**
   * Get document by Zakononline ID
   */
  async getDocumentByZoId(zakononline_id: string): Promise<Document | null> {
    try {
      const result = await this.db.query(
        'SELECT * FROM documents WHERE zakononline_id = $1',
        [zakononline_id]
      );

      if (result.rows.length === 0) {
        return null;
      }

      return result.rows[0];
    } catch (error: any) {
      logger.error('Failed to get document:', {
        zakononline_id,
        error: error.message,
      });
      return null;
    }
  }

  /**
   * Get document by internal UUID
   */
  async getDocumentById(id: string): Promise<Document | null> {
    try {
      const result = await this.db.query(
        'SELECT * FROM documents WHERE id = $1',
        [id]
      );

      if (result.rows.length === 0) {
        return null;
      }

      return result.rows[0];
    } catch (error: any) {
      logger.error('Failed to get document by id:', {
        id,
        error: error.message,
      });
      return null;
    }
  }

  /**
   * Update document full text
   */
  async updateFullText(zakononline_id: string, full_text: string): Promise<boolean> {
    try {
      const result = await this.db.query(
        `UPDATE documents 
         SET full_text = $1, updated_at = NOW() 
         WHERE zakononline_id = $2
         RETURNING id`,
        [full_text, zakononline_id]
      );

      if (result.rows.length === 0) {
        logger.warn('Document not found for full text update', { zakononline_id });
        return false;
      }

      logger.info('Document full text updated', {
        zakononline_id,
        textLength: full_text.length,
      });

      return true;
    } catch (error: any) {
      logger.error('Failed to update full text:', {
        zakononline_id,
        error: error.message,
      });
      return false;
    }
  }

  /**
   * Check if document exists
   */
  async documentExists(zakononline_id: string): Promise<boolean> {
    try {
      const result = await this.db.query(
        'SELECT 1 FROM documents WHERE zakononline_id = $1 LIMIT 1',
        [zakononline_id]
      );
      return result.rows.length > 0;
    } catch (error: any) {
      logger.error('Failed to check document existence:', {
        zakononline_id,
        error: error.message,
      });
      return false;
    }
  }

  /**
   * Get statistics about documents
   */
  async getStats(): Promise<any> {
    try {
      const result = await this.db.query(`
        SELECT
          COUNT(*) as total_documents,
          COUNT(full_text) as documents_with_full_text,
          COUNT(DISTINCT type) as unique_types,
          MIN(created_at) as oldest_document,
          MAX(created_at) as newest_document
        FROM documents
      `);

      return result.rows[0];
    } catch (error) {
      logger.error('Failed to get document stats:', error);
      return null;
    }
  }

  /**
   * Save document sections to database
   * Deletes existing sections for the document first, then inserts new ones
   */
  async saveSections(documentId: string, sections: DocumentSection[]): Promise<void> {
    if (!sections || sections.length === 0) {
      logger.warn('No sections to save', { documentId });
      return;
    }

    try {
      await this.db.transaction(async (client) => {
        // Delete existing sections for this document
        await client.query(
          'DELETE FROM document_sections WHERE document_id = $1',
          [documentId]
        );

        // Insert new sections
        for (const section of sections) {
          await client.query(
            `INSERT INTO document_sections (
              id, document_id, section_type, text, start_index, end_index, confidence
            ) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
            [
              uuidv4(),
              documentId,
              section.type,
              section.text,
              section.start_index || null,
              section.end_index || null,
              section.confidence || 0.0,
            ]
          );
        }

        logger.info('Document sections saved', {
          documentId,
          sectionsCount: sections.length,
        });
      });
    } catch (error: any) {
      logger.error('Failed to save document sections:', {
        documentId,
        error: error.message,
      });
      throw error;
    }
  }

  /**
   * Get sections for a document
   */
  async getSections(documentId: string): Promise<DocumentSection[]> {
    try {
      const result = await this.db.query(
        'SELECT * FROM document_sections WHERE document_id = $1 ORDER BY start_index ASC',
        [documentId]
      );

      return result.rows.map(row => ({
        type: row.section_type,
        text: row.text,
        start_index: row.start_index,
        end_index: row.end_index,
        confidence: row.confidence,
      }));
    } catch (error: any) {
      logger.error('Failed to get document sections:', {
        documentId,
        error: error.message,
      });
      return [];
    }
  }
}
