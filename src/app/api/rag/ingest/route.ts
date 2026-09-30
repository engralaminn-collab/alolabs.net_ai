import { NextRequest, NextResponse } from 'next/server'
import { ingestDocument } from '@/lib/rag-engine'

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
      collectionId,
      documentId,
      content,
      companyId,
      source,
      classification,
      chunkSize,
      overlap,
    } = body

    if (!collectionId || !documentId || !content) {
      return NextResponse.json(
        { error: 'collectionId, documentId, and content are required' },
        { status: 400 }
      )
    }

    if (typeof content !== 'string' || content.trim().length === 0) {
      return NextResponse.json(
        { error: 'content must be a non-empty string' },
        { status: 400 }
      )
    }

    const result = await ingestDocument(collectionId, documentId, content, {
      companyId: companyId || undefined,
      source: source || undefined,
      classification: classification || undefined,
      chunkSize: chunkSize || undefined,
      overlap: overlap || undefined,
    })

    if (result.errors.length > 0 && result.chunksCreated === 0) {
      return NextResponse.json(
        { error: 'Ingestion failed', details: result.errors, result },
        { status: 422 }
      )
    }

    return NextResponse.json(result, { status: 200 })
  } catch (error) {
    console.error('[RAG Ingest] Error:', error)
    const message = error instanceof Error ? error.message : 'Failed to ingest document'
    return NextResponse.json({ error: message }, { status: 500 })
  }
}