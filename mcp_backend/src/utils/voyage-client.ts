/**
 * VoyageAI embedding client using native fetch (Node 20+).
 * Supports voyage-law-2 and other Voyage embedding models.
 */

const VOYAGE_API_URL = 'https://api.voyageai.com/v1/embeddings';
const MAX_RETRIES = 3;
const BATCH_SIZE = 50; // VoyageAI supports up to 128, use 50 to match existing pattern

interface VoyageEmbeddingResponse {
  object: string;
  data: Array<{ object: string; embedding: number[]; index: number }>;
  model: string;
  usage: { total_tokens: number };
}

export class VoyageAIClient {
  constructor(private apiKey: string) {
    if (!apiKey) {
      throw new Error('VOYAGEAI_API_KEY is required');
    }
  }

  async generateEmbedding(text: string, model: string = 'voyage-multilingual-2'): Promise<number[]> {
    const results = await this.generateEmbeddingsBatch([text], model);
    return results[0];
  }

  async generateEmbeddingsBatch(texts: string[], model: string = 'voyage-multilingual-2'): Promise<number[][]> {
    const allEmbeddings: number[][] = [];

    for (let i = 0; i < texts.length; i += BATCH_SIZE) {
      const batch = texts.slice(i, i + BATCH_SIZE);
      const embeddings = await this._embedBatchWithRetry(batch, model);
      allEmbeddings.push(...embeddings);
    }

    return allEmbeddings;
  }

  private async _embedBatchWithRetry(texts: string[], model: string): Promise<number[][]> {
    let lastError: Error | null = null;

    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      try {
        return await this._embedBatch(texts, model);
      } catch (err: any) {
        lastError = err;

        if (err.status === 429) {
          // Rate limited — exponential backoff
          const delay = Math.pow(2, attempt) * 1000;
          await new Promise((r) => setTimeout(r, delay));
          continue;
        }

        // Non-retryable error
        throw err;
      }
    }

    throw lastError ?? new Error('VoyageAI: max retries exceeded');
  }

  private async _embedBatch(texts: string[], model: string): Promise<number[][]> {
    const response = await fetch(VOYAGE_API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({ input: texts, model }),
    });

    if (!response.ok) {
      const body = await response.text();
      const err: any = new Error(`VoyageAI API error ${response.status}: ${body}`);
      err.status = response.status;
      throw err;
    }

    const data = (await response.json()) as VoyageEmbeddingResponse;
    // Sort by index to ensure order is preserved
    return data.data.sort((a, b) => a.index - b.index).map((d) => d.embedding);
  }
}
