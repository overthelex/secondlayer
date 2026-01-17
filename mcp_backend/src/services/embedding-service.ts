import { QdrantClient } from '@qdrant/js-client-rest';
import { EmbeddingChunk, SectionType } from '../types/index.js';
import { logger } from '../utils/logger.js';
import { getOpenAIManager } from '../utils/openai-client.js';
import { v4 as uuidv4 } from 'uuid';

const EMBEDDING_DIMENSION = 1536; // OpenAI ada-002
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
      const response = await this.openaiManager.executeWithRetry(async (client) => {
        return await client.embeddings.create({
          model: 'text-embedding-ada-002',
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
      const response = await this.openaiManager.executeWithRetry(async (client) => {
        return await client.embeddings.create({
          model: 'text-embedding-ada-002',
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
      await this.qdrant.upsert(this.collectionName, {
        wait: true,
        points: [
          {
            id: vectorId,
            vector: chunk.embedding,
            payload: {
              doc_id: chunk.doc_id,
              section_type: chunk.section_type,
              text: chunk.text,
              date: chunk.metadata.date,
              court: chunk.metadata.court || null,
              law_articles: chunk.metadata.law_articles || [],
            },
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
    },
    limit: number = 10
  ): Promise<any[]> {
    await this.initialize();

    try {
      const queryFilter: any = {};

      if (filters) {
        const must: any[] = [];
        
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
        text: result.payload?.text,
        doc_id: result.payload?.doc_id,
        section_type: result.payload?.section_type,
        metadata: {
          date: result.payload?.date,
          court: result.payload?.court,
          law_articles: result.payload?.law_articles || [],
        },
      }));
    } catch (error) {
      logger.error('Similarity search error:', error);
      throw error;
    }
  }
}
