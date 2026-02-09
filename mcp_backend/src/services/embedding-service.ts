import { QdrantClient } from '@qdrant/js-client-rest';
import { EmbeddingChunk, SectionType, PrecedentStatusType } from '../types/index.js';
import { logger } from '../utils/logger.js';
import { getOpenAIManager } from '../utils/openai-client.js';
import { ModelSelector } from '../utils/model-selector.js';
import { v4 as uuidv4 } from 'uuid';

const EMBEDDING_DIMENSION = 1536; // OpenAI ada-002 and text-embedding-3-small
const MAX_CHUNK_TOKENS = 512;
const CHUNK_OVERLAP = 50;

export class EmbeddingService {
  private openaiManager = getOpenAIManager();
  private qdrant: QdrantClient;
  private collectionName = 'legal_sections';
  private initialized = false;

  constructor() {

    const qdrantUrl = process.env.QDRANT_URL || 'http://localhost:6333';
    this.qdrant = new QdrantClient({ url: qdrantUrl });
  }

  async initialize() {
    if (this.initialized) return;

    try {
      // Check if collection exists
      const collections = await this.qdrant.getCollections();
      const exists = collections.collections.some(
        (c) => c.name === this.collectionName
      );

      if (!exists) {
        await this.qdrant.createCollection(this.collectionName, {
          vectors: {
            size: EMBEDDING_DIMENSION,
            distance: 'Cosine',
          },
        });
        logger.info('Qdrant collection created');
      }

      this.initialized = true;
      logger.info('Embedding service initialized');
    } catch (error) {
      logger.error('Failed to initialize embedding service:', error);
      throw error;
    }
  }

  async generateEmbedding(text: string): Promise<number[]> {
    try {
      const model = ModelSelector.getEmbeddingModel();
      const response = await this.openaiManager.executeWithRetry(async (client) => {
        return await client.embeddings.create({
          model,
          input: text,
        });
      });

      return response.data[0].embedding;
    } catch (error) {
      logger.error('Embedding generation error:', error);
      throw error;
    }
  }

  async generateEmbeddingsBatch(texts: string[]): Promise<number[][]> {
    try {
      const model = ModelSelector.getEmbeddingModel();
      const response = await this.openaiManager.executeWithRetry(async (client) => {
        return await client.embeddings.create({
          model,
          input: texts,
        });
      });

      return response.data.map((item) => item.embedding);
    } catch (error) {
      logger.error('Batch embedding generation error:', error);
      throw error;
    }
  }

  splitIntoChunks(text: string): string[] {
    const chunks: string[] = [];
    const words = text.split(/\s+/);
    let currentChunk: string[] = [];
    let currentLength = 0;

    for (const word of words) {
      const wordLength = word.length + 1; // +1 for space
      
      if (currentLength + wordLength > MAX_CHUNK_TOKENS * 4) {
        // Approximate: 1 token ≈ 4 characters
        if (currentChunk.length > 0) {
          chunks.push(currentChunk.join(' '));
          
          // Overlap: keep last N words
          const overlapWords = currentChunk.slice(-CHUNK_OVERLAP);
          currentChunk = overlapWords;
          currentLength = overlapWords.join(' ').length;
        }
      }

      currentChunk.push(word);
      currentLength += wordLength;
    }

    if (currentChunk.length > 0) {
      chunks.push(currentChunk.join(' '));
    }

    return chunks;
  }

  async storeChunk(chunk: EmbeddingChunk): Promise<string> {
    await this.initialize();

    const vectorId = chunk.id || uuidv4();
    
    try {
      const payload: Record<string, any> = {
        doc_id: chunk.doc_id,
        section_type: chunk.section_type,
        text: chunk.text,
        date: chunk.metadata.date,
        court: chunk.metadata.court || null,
        case_number: chunk.metadata.case_number || null,
        chamber: chunk.metadata.chamber || null,
        dispute_category: chunk.metadata.dispute_category || null,
        outcome: chunk.metadata.outcome || null,
        deviation_flag: chunk.metadata.deviation_flag ?? null,
        precedent_status: chunk.metadata.precedent_status || null,
        law_articles: chunk.metadata.law_articles || [],
      };

      // Include matter_id in payload if present (for matter-level filtering)
      if ((chunk.metadata as any).matter_id) {
        payload.matter_id = (chunk.metadata as any).matter_id;
      }

      await this.qdrant.upsert(this.collectionName, {
        wait: true,
        points: [
          {
            id: vectorId,
            vector: chunk.embedding,
            payload,
          },
        ],
      });

      return vectorId;
    } catch (error) {
      logger.error('Failed to store chunk:', error);
      throw error;
    }
  }

  async searchSimilar(
    queryEmbedding: number[],
    filters?: {
      section_type?: SectionType;
      date_from?: string;
      date_to?: string;
      court?: string;
      chamber?: string | string[];
      dispute_category?: string;
      outcome?: string;
      deviation_flag?: boolean | null;
      precedent_status?: PrecedentStatusType;
      case_number?: string;
      matter_id?: string;
    },
    limit: number = 10
  ): Promise<any[]> {
    await this.initialize();

    try {
      const queryFilter: any = {};

      if (filters) {
        const must: any[] = [];
        const should: any[] = [];
        
        if (filters.section_type) {
          must.push({
            key: 'section_type',
            match: { value: filters.section_type },
          });
        }

        if (filters.date_from || filters.date_to) {
          must.push({
            key: 'date',
            range: {
              gte: filters.date_from,
              lte: filters.date_to,
            },
          });
        }

        if (filters.court) {
          must.push({
            key: 'court',
            match: { value: filters.court },
          });
        }

        if (filters.chamber) {
          if (Array.isArray(filters.chamber)) {
            for (const chamber of filters.chamber) {
              should.push({
                key: 'chamber',
                match: { value: chamber },
              });
            }
          } else {
            must.push({
              key: 'chamber',
              match: { value: filters.chamber },
            });
          }
        }

        if (filters.dispute_category) {
          must.push({
            key: 'dispute_category',
            match: { value: filters.dispute_category },
          });
        }

        if (filters.outcome) {
          must.push({
            key: 'outcome',
            match: { value: filters.outcome },
          });
        }

        if (filters.deviation_flag !== undefined) {
          must.push({
            key: 'deviation_flag',
            match: { value: filters.deviation_flag },
          });
        }

        if (filters.precedent_status) {
          must.push({
            key: 'precedent_status',
            match: { value: filters.precedent_status },
          });
        }

        if (filters.case_number) {
          must.push({
            key: 'case_number',
            match: { value: filters.case_number },
          });
        }

        if (filters.matter_id) {
          must.push({
            key: 'matter_id',
            match: { value: filters.matter_id },
          });
        }

        if (must.length > 0) {
          queryFilter.must = must;
        }

        if (should.length > 0) {
          queryFilter.should = should;
        }
      }

      const searchResult = await this.qdrant.search(this.collectionName, {
        vector: queryEmbedding,
        limit,
        filter: Object.keys(queryFilter).length > 0 ? queryFilter : undefined,
        with_payload: true,
      });

      return searchResult.map((result) => ({
        id: result.id,
        score: result.score,
        text: result.payload?.text,
        doc_id: result.payload?.doc_id,
        section_type: result.payload?.section_type,
        metadata: {
          date: result.payload?.date,
          court: result.payload?.court,
          case_number: result.payload?.case_number,
          chamber: result.payload?.chamber,
          dispute_category: result.payload?.dispute_category,
          outcome: result.payload?.outcome,
          deviation_flag: result.payload?.deviation_flag,
          precedent_status: result.payload?.precedent_status,
          law_articles: result.payload?.law_articles || [],
        },
      }));
    } catch (error) {
      logger.error('Similarity search error:', error);
      throw error;
    }
  }

  async upsertVector(
    vectorId: string,
    embedding: number[],
    payload: Record<string, any>
  ): Promise<void> {
    await this.initialize();

    try {
      await this.qdrant.upsert(this.collectionName, {
        wait: true,
        points: [
          {
            id: vectorId,
            vector: embedding,
            payload,
          },
        ],
      });
    } catch (error) {
      logger.error('Failed to upsert vector:', error);
      throw error;
    }
  }

  async deleteByDocId(docId: string): Promise<void> {
    await this.initialize();

    try {
      await this.qdrant.delete(this.collectionName, {
        filter: {
          must: [{ key: 'doc_id', match: { value: docId } }],
        },
      });
      logger.info('Deleted vectors for document', { docId });
    } catch (error) {
      logger.error('Failed to delete vectors for document:', { docId, error });
      throw error;
    }
  }

  async searchVectors(
    queryEmbedding: number[],
    limit: number = 10,
    filter?: Record<string, any>
  ): Promise<any[]> {
    await this.initialize();

    try {
      const queryFilter: any = {};

      if (filter) {
        const must: any[] = [];

        for (const [key, value] of Object.entries(filter)) {
          if (value !== undefined && value !== null) {
            must.push({
              key,
              match: { value },
            });
          }
        }

        if (must.length > 0) {
          queryFilter.must = must;
        }
      }

      const searchResult = await this.qdrant.search(this.collectionName, {
        vector: queryEmbedding,
        limit,
        filter: Object.keys(queryFilter).length > 0 ? queryFilter : undefined,
        with_payload: true,
      });

      return searchResult.map((result) => ({
        id: result.id,
        score: result.score,
        payload: result.payload,
      }));
    } catch (error) {
      logger.error('Vector search error:', error);
      throw error;
    }
  }
}
