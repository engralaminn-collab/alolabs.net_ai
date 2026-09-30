/**
 * RAG Engine - Enhanced
 * Provides document chunking, embedding generation, and hybrid search.
 * Integrates with Qdrant for vector storage and z-ai-web-dev-sdk for embeddings.
 */

import { db } from './db';
import { searchPoints, upsertPoints, createCollection, isQdrantConnected } from './qdrant';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface ChunkResult {
  id: string;
  content: string;
  metadata: Record<string, unknown>;
  position: number;
  embedding?: number[];
}

export interface SearchResult {
  id: string;
  content: string;
  score: number;
  metadata: Record<string, unknown>;
  position: number;
  source?: string;
}

export interface IngestResult {
  documentId: string;
  chunksCreated: number;
  chunksWithEmbeddings: number;
  errors: string[];
  durationMs: number;
}

export interface QueryResult {
  query: string;
  results: SearchResult[];
  totalFound: number;
  durationMs: number;
  collectionName?: string;
}

// ─── Text Chunking ────────────────────────────────────────────────────────────

const DEFAULT_CHUNK_SIZE = 512;
const DEFAULT_CHUNK_OVERLAP = 50;
const DEFAULT_MAX_CHUNKS = 100;

export function chunkText(
  text: string,
  options?: { chunkSize?: number; overlap?: number; maxChunks?: number }
): { content: string; position: number }[] {
  const chunkSize = options?.chunkSize || DEFAULT_CHUNK_SIZE;
  const overlap = options?.overlap || DEFAULT_CHUNK_OVERLAP;
  const maxChunks = options?.maxChunks || DEFAULT_MAX_CHUNKS;

  if (!text || text.trim().length === 0) return [];

  // Normalize whitespace
  const normalized = text.replace(/\r\n/g, '\n').replace(/\n{3,}/g, '\n\n');

  // Split by paragraphs first, then sentences
  const paragraphs = normalized.split(/\n\n+/).filter((p) => p.trim().length > 0);

  const chunks: { content: string; position: number }[] = [];
  let buffer = '';
  let position = 0;

  for (const para of paragraphs) {
    if (buffer.length + para.length > chunkSize && buffer.length > 0) {
      // Flush buffer as a chunk
      chunks.push({ content: buffer.trim(), position: position++ });
      // Keep overlap from end of buffer
      if (overlap > 0 && buffer.length > overlap) {
        const sentences = buffer.split(/(?<=[.!?])\s+/);
        let overlapText = '';
        for (let i = sentences.length - 1; i >= 0 && overlapText.length < overlap; i--) {
          overlapText = sentences[i] + ' ' + overlapText;
        }
        buffer = overlapText.trim();
      } else {
        buffer = '';
      }
    }

    buffer += (buffer ? '\n\n' : '') + para;

    // If a single paragraph is too long, split by sentences
    if (buffer.length > chunkSize * 1.5) {
      const sentences = buffer.split(/(?<=[.!?])\s+/);
      let subBuffer = '';
      for (const sentence of sentences) {
        if (subBuffer.length + sentence.length > chunkSize && subBuffer.length > 0) {
          chunks.push({ content: subBuffer.trim(), position: position++ });
          subBuffer = sentence;
        } else {
          subBuffer += ' ' + sentence;
        }
      }
      buffer = subBuffer.trim();
    }

    if (chunks.length >= maxChunks) break;
  }

  // Flush remaining buffer
  if (buffer.trim().length > 0 && chunks.length < maxChunks) {
    chunks.push({ content: buffer.trim(), position: position++ });
  }

  return chunks;
}

// ─── Embedding Generation ─────────────────────────────────────────────────────

const VECTOR_DIMENSIONS = 1536;

/**
 * Generate embeddings using external API or fallback to hash-based embeddings.
 * Supports any OpenAI-compatible embedding endpoint (OpenAI, Ollama, vLLM, etc.)
 */
export async function generateEmbedding(text: string): Promise<number[]> {
  // Try external embedding API first
  const embeddingApi = process.env.EMBEDDING_API_URL
  const embeddingKey = process.env.EMBEDDING_API_KEY
  const embeddingModel = process.env.EMBEDDING_MODEL || 'text-embedding-3-small'

  if (embeddingApi && embeddingKey) {
    try {
      const res = await fetch(embeddingApi, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${embeddingKey}`,
        },
        body: JSON.stringify({
          model: embeddingModel,
          input: text,
          dimensions: VECTOR_DIMENSIONS,
        }),
        signal: AbortSignal.timeout(10000),
      })
      if (res.ok) {
        const data = await res.json()
        if (data.data?.[0]?.embedding) {
          return data.data[0].embedding
        }
      }
    } catch {
      // External API failed, fall through to fallback
    }
  }

  return generateFallbackEmbedding(text)
}

/**
 * Generate multiple embeddings in batch
 */
export async function generateEmbeddings(texts: string[]): Promise<number[][]> {
  return Promise.all(texts.map((t) => generateEmbedding(t)));
}

function generateFallbackEmbedding(text: string): number[] {
  // Fallback embedding generator when no embedding API is configured.
  // This produces a deterministic but NON-SEMANTIC vector.
  // The hybrid search still works via keyword matching.
  console.warn('[RAG] No embedding API configured. Using fallback hash-based embeddings. Vector search results will not be semantically accurate. Set EMBEDDING_API_URL and EMBEDDING_API_KEY for real embeddings.');
  const vector = new Array(VECTOR_DIMENSIONS).fill(0);

  // Simple hash-based approach for deterministic vectors
  let hash = 0;
  for (let i = 0; i < text.length; i++) {
    const char = text.charCodeAt(i);
    hash = ((hash << 5) - hash + char) | 0;
  }

  // Seed a simple PRNG with the hash
  let seed = Math.abs(hash);
  function nextRand() {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  }

  // Generate normalized random vector
  let sumSq = 0;
  for (let i = 0; i < VECTOR_DIMENSIONS; i++) {
    vector[i] = (nextRand() * 2 - 1);
    sumSq += vector[i] * vector[i];
  }

  // Normalize
  const norm = Math.sqrt(sumSq);
  if (norm > 0) {
    for (let i = 0; i < VECTOR_DIMENSIONS; i++) {
      vector[i] /= norm;
    }
  }

  // Bias first 10 dimensions with actual text characteristics
  vector[0] = Math.min(1, text.length / 500);
  vector[1] = (text.split(/\s+/).length / 100) - 0.5;
  vector[2] = ((text.match(/[A-Z]/g) || []).length / text.length) * 2 - 1;
  vector[3] = ((text.match(/\d/g) || []).length / text.length) * 2 - 1;
  vector[4] = ((text.match(/[!?.]/g) || []).length / 10) - 0.5;
  vector[5] = text.includes('\n') ? 0.8 : 0.2;
  vector[6] = text.includes('@') ? 0.9 : 0.1;
  vector[7] = ((text.match(/https?:\/\//g) || []).length > 0) ? 0.9 : 0.1;
  vector[8] = (text.length > 200 ? 0.8 : 0.2);
  vector[9] = ((text.match(/\b(the|is|at|which|on)\b/gi) || []).length / 5) - 0.5;

  return vector;
}

// ─── Document Ingestion ───────────────────────────────────────────────────────

export async function ingestDocument(
  collectionId: string,
  documentId: string,
  content: string,
  options?: {
    companyId?: string;
    source?: string;
    classification?: string;
    chunkSize?: number;
    overlap?: number;
    generateEmbeddings?: boolean;
  }
): Promise<IngestResult> {
  const startTime = Date.now();
  const errors: string[] = [];
  let chunksWithEmbeddings = 0;

  try {
    // Verify collection and document exist
    const collection = await db.ragCollection.findUnique({ where: { id: collectionId } });
    if (!collection) throw new Error(`Collection ${collectionId} not found`);

    const document = await db.ragDocument.findUnique({ where: { id: documentId } });
    if (!document) throw new Error(`Document ${documentId} not found`);

    // Chunk the text
    const textChunks = chunkText(content, {
      chunkSize: options?.chunkSize,
      overlap: options?.overlap,
    });

    if (textChunks.length === 0) {
      return {
        documentId,
        chunksCreated: 0,
        chunksWithEmbeddings: 0,
        errors: ['No text content to chunk'],
        durationMs: Date.now() - startTime,
      };
    }

    // Create Qdrant collection if connected
    if (isQdrantConnected()) {
      try {
        await createCollection(collection.name, VECTOR_DIMENSIONS);
      } catch (e: unknown) {
        errors.push(`Qdrant collection: ${e instanceof Error ? e.message : String(e)}`);
      }
    }

    // Generate embeddings for all chunks
    const shouldEmbed = options?.generateEmbeddings !== false;
    let embeddings: number[][] = [];
    if (shouldEmbed) {
      try {
        embeddings = await generateEmbeddings(textChunks.map((c) => c.content));
      } catch (e: unknown) {
        errors.push(`Embedding generation: ${e instanceof Error ? e.message : String(e)}`);
      }
    }

    // Store chunks in DB
    const chunkRecords = await db.ragChunk.createMany({
      data: textChunks.map((chunk, i) => ({
        documentId,
        companyId: options?.companyId || null,
        content: chunk.content,
        position: chunk.position,
        metadata: JSON.stringify({
          chunkIndex: i,
          totalChunks: textChunks.length,
          source: options?.source || document.source,
          classification: options?.classification || document.classification,
          collectionName: collection.name,
          embeddingGenerated: embeddings.length > 0,
        }),
      })),
    });

    chunksWithEmbeddings = embeddings.length;

    // Upsert vectors to Qdrant
    if (embeddings.length > 0 && isQdrantConnected()) {
      try {
        // Get the created chunk IDs by querying back
        const createdChunks = await db.ragChunk.findMany({
          where: { documentId },
          orderBy: { position: 'asc' },
          select: { id: true, position: true },
        });

        const points = createdChunks
          .filter((c) => c.position < embeddings.length)
          .map((c, i) => ({
            id: c.id,
            vector: embeddings[c.position] || embeddings[i],
            payload: {
              chunkId: c.id,
              documentId,
              collectionId,
              companyId: options?.companyId || null,
              collectionName: collection.name,
            },
          }));

        if (points.length > 0) {
          await upsertPoints(collection.name, points);
        }
      } catch (e: unknown) {
        errors.push(`Qdrant upsert: ${e instanceof Error ? e.message : String(e)}`);
      }
    }

    // Update document status
    await db.ragDocument.update({
      where: { id: documentId },
      data: {
        status: 'indexed',
        indexedAt: new Date(),
        chunkCount: textChunks.length,
      },
    });

    return {
      documentId,
      chunksCreated: textChunks.length,
      chunksWithEmbeddings,
      errors,
      durationMs: Date.now() - startTime,
    };
  } catch (err: unknown) {
    return {
      documentId,
      chunksCreated: 0,
      chunksWithEmbeddings: 0,
      errors: [err instanceof Error ? err.message : String(err)],
      durationMs: Date.now() - startTime,
    };
  }
}

// ─── Hybrid Search ────────────────────────────────────────────────────────────

export async function hybridSearch(
  query: string,
  options?: {
    collectionId?: string;
    collectionName?: string;
    companyId?: string;
    limit?: number;
    vectorWeight?: number;
    keywordWeight?: number;
  }
): Promise<QueryResult> {
  const startTime = Date.now();
  const limit = options?.limit || 5;
  const vectorWeight = options?.vectorWeight || 0.7;
  const keywordWeight = options?.keywordWeight || 0.3;

  // 1. Get query embedding for vector search
  let vectorResults: { id: string; score: number; payload: Record<string, unknown> }[] = [];

  if (isQdrantConnected() && options?.collectionName) {
    try {
      const queryEmbedding = await generateEmbedding(query);
      vectorResults = await searchPoints(options.collectionName, queryEmbedding, limit * 2, {
        companyId: options?.companyId,
        collectionId: options?.collectionId,
      } as Record<string, unknown>);
    } catch {
      // Vector search failed, continue with keyword-only
    }
  }

  // 2. Keyword search from DB
  const chunkWhere: Record<string, unknown> = {};
  if (options?.companyId) chunkWhere.companyId = options.companyId;
  if (options?.collectionId) {
    const docIds = await db.ragDocument.findMany({
      where: { collectionId: options.collectionId },
      select: { id: true },
    });
    chunkWhere.documentId = { in: docIds.map((d) => d.id) };
  }

  // Multi-keyword matching using SQLite LIKE (OR all keywords)
  const keywords = query.toLowerCase().split(/\s+/).filter((w) => w.length > 2).slice(0, 5);
  let keywordResults;
  if (keywords.length > 0) {
    // Build OR conditions for multiple keywords
    const orConditions = keywords.map((kw) => ({ content: { contains: kw } }));
    keywordResults = await db.ragChunk.findMany({
      where: {
        ...chunkWhere,
        OR: orConditions,
      },
      orderBy: { createdAt: 'desc' },
      take: limit * 2,
    });
  } else {
    keywordResults = await db.ragChunk.findMany({
      where: chunkWhere,
      orderBy: { createdAt: 'desc' },
      take: limit * 2,
    });
  }

  // 3. Score and merge results
  const scoredResults = new Map<string, { result: SearchResult; vectorScore: number; keywordScore: number }>();

  // Score vector results
  for (const vr of vectorResults) {
    const existing = scoredResults.get(vr.id);
    if (existing) {
      existing.vectorScore = vr.score;
    } else {
      let metadata: Record<string, unknown> = {};
      try { metadata = vr.payload || {}; } catch { /* ignore */ }
      scoredResults.set(vr.id, {
        result: {
          id: vr.id,
          content: (metadata.content as string) || '',
          score: vr.score * vectorWeight,
          metadata,
          position: (metadata.position as number) || 0,
          source: (metadata.source as string) || '',
        },
        vectorScore: vr.score,
        keywordScore: 0,
      });
    }
  }

  // Score keyword results
  for (const kr of keywordResults) {
    const existing = scoredResults.get(kr.id);
    const kScore = calculateKeywordScore(kr.content, keywords);

    if (existing) {
      existing.keywordScore = kScore;
      existing.result.score = existing.vectorScore * vectorWeight + kScore * keywordWeight;
      if (!existing.result.content) {
        existing.result.content = kr.content;
        existing.result.position = kr.position;
      }
    } else {
      let metadata: Record<string, unknown> = {};
      try { metadata = JSON.parse(kr.metadata || '{}'); } catch { /* ignore */ }
      scoredResults.set(kr.id, {
        result: {
          id: kr.id,
          content: kr.content,
          score: kScore * keywordWeight,
          metadata,
          position: kr.position,
          source: (metadata.source as string) || '',
        },
        vectorScore: 0,
        keywordScore: kScore,
      });
    }
  }

  // Sort by combined score
  const sortedResults = Array.from(scoredResults.values())
    .sort((a, b) => b.result.score - a.result.score)
    .slice(0, limit)
    .map((entry) => entry.result);

  // 4. Log the query
  const ragQuery = await db.ragQuery.create({
    data: {
      companyId: options?.companyId || null,
      query,
      collectionId: options?.collectionId || null,
      resultCount: sortedResults.length,
      status: sortedResults.length > 0 ? 'success' : 'no_results',
      durationMs: Date.now() - startTime,
    },
  });

  // 5. Build answer from results
  const answerContent = sortedResults.length > 0
    ? `Based on ${sortedResults.length} relevant document${sortedResults.length > 1 ? 's' : ''}:\n\n${sortedResults.map((r, i) => `[${i + 1}] (score: ${r.score.toFixed(3)}) ${r.content.substring(0, 300)}${r.content.length > 300 ? '...' : ''}`).join('\n\n')}`
    : 'No relevant documents found. Consider adding more documents to the knowledge base.';

  await db.ragAnswer.create({
    data: {
      queryId: ragQuery.id,
      companyId: options?.companyId || null,
      content: answerContent,
      chunks: JSON.stringify(sortedResults.map((r) => r.id)),
      confidence: sortedResults.length > 0 ? Math.min(0.95, 0.5 + sortedResults[0].score * 0.5) : 0,
    },
  });

  return {
    query,
    results: sortedResults,
    totalFound: scoredResults.size,
    durationMs: Date.now() - startTime,
    collectionName: options?.collectionName,
  };
}

function calculateKeywordScore(content: string, keywords: string[]): number {
  if (keywords.length === 0) return 0;
  const lower = content.toLowerCase();
  let matches = 0;
  for (const kw of keywords) {
    if (lower.includes(kw)) matches++;
  }
  return matches / keywords.length;
}

// ─── Document Management ──────────────────────────────────────────────────────

export async function deleteDocumentChunks(documentId: string): Promise<number> {
  // Delete from Qdrant first
  if (isQdrantConnected()) {
    try {
      const chunks = await db.ragChunk.findMany({
        where: { documentId },
        select: { id: true },
      });
      const { deletePoints } = await import('./qdrant');
      // Get collection name from document
      const doc = await db.ragDocument.findUnique({ where: { id: documentId } });
      if (doc) {
        const collection = await db.ragCollection.findUnique({ where: { id: doc.collectionId } });
        if (collection) {
          await deletePoints(collection.name, chunks.map((c) => c.id));
        }
      }
    } catch {
      // Ignore Qdrant errors
    }
  }

  const result = await db.ragChunk.deleteMany({ where: { documentId } });
  return result.count;
}

export async function getRagEngineStats(): Promise<{
  collections: number;
  documents: number;
  chunks: number;
  qdrantConnected: boolean;
  averageChunksPerDoc: number;
  totalQueries: number;
  averageQueryDurationMs: number;
}> {
  const [collections, documents, chunks, queries] = await Promise.all([
    db.ragCollection.count(),
    db.ragDocument.count(),
    db.ragChunk.count(),
    db.ragQuery.aggregate({ _avg: { durationMs: true }, _count: true }),
  ]);

  return {
    collections,
    documents,
    chunks,
    qdrantConnected: isQdrantConnected(),
    averageChunksPerDoc: documents > 0 ? Math.round(chunks / documents) : 0,
    totalQueries: queries._count,
    averageQueryDurationMs: Math.round(queries._avg.durationMs || 0),
  };
}