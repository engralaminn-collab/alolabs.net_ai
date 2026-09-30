import { NextRequest, NextResponse } from 'next/server'
import { hybridSearch } from '@/lib/rag-engine'

export async function POST(request: NextRequest) {
  // Auth check
  const authHeader = request.headers.get('authorization');
  const token = authHeader?.replace('Bearer ', '');
  if (!token) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const { verifySessionToken } = await import('@/lib/auth');
  const session = await verifySessionToken(token);
  if (!session) return NextResponse.json({ error: 'Invalid token' }, { status: 401 });
  try {
    const body = await request.json()
    const {
      query,
      collectionId,
      collectionName,
      companyId,
      limit,
      vectorWeight,
      keywordWeight,
    } = body

    if (!query || typeof query !== 'string' || query.trim().length === 0) {
      return NextResponse.json(
        { error: 'query is required and must be a non-empty string' },
        { status: 400 }
      )
    }

    // If collectionName is not provided but collectionId is, look up the collection name
    let resolvedCollectionName = collectionName
    if (!resolvedCollectionName && collectionId) {
      const { db } = await import('@/lib/db')
      const collection = await db.ragCollection.findUnique({
        where: { id: collectionId },
        select: { name: true },
      })
      resolvedCollectionName = collection?.name || undefined
    }

    const result = await hybridSearch(query.trim(), {
      collectionId: collectionId || undefined,
      collectionName: resolvedCollectionName || undefined,
      companyId: companyId || undefined,
      limit: limit || undefined,
      vectorWeight: vectorWeight || undefined,
      keywordWeight: keywordWeight || undefined,
    })

    return NextResponse.json(result, { status: 200 })
  } catch (error) {
    console.error('[RAG Search] Error:', error)
    const message = error instanceof Error ? error.message : 'Failed to perform hybrid search'
    return NextResponse.json({ error: message }, { status: 500 })
  }
}