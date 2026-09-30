import { db } from '@/lib/db'
import { NextRequest, NextResponse } from 'next/server'

export async function GET(request: NextRequest) {
  // Auth check
  const authHeader = request.headers.get('authorization');
  const token = authHeader?.replace('Bearer ', '');
  if (!token) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const { verifySessionToken } = await import('@/lib/auth');
  const session = await verifySessionToken(token);
  if (!session) return NextResponse.json({ error: 'Invalid token' }, { status: 401 });
  try {
    const collections = await db.ragCollection.findMany({
      orderBy: { createdAt: 'desc' },
    })

    return NextResponse.json(collections)
  } catch (error) {
    console.error('[RAG Collections List] Error:', error)
    return NextResponse.json(
      { error: 'Failed to list RAG collections' },
      { status: 500 }
    )
  }
}

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
    const { companyId, name, description } = body

    if (!name) {
      return NextResponse.json(
        { error: 'name is required' },
        { status: 400 }
      )
    }

    const collection = await db.ragCollection.create({
      data: {
        companyId: companyId || null,
        name,
        description: description || null,
      },
    })

    return NextResponse.json(collection, { status: 201 })
  } catch (error) {
    console.error('[RAG Collection Create] Error:', error)
    return NextResponse.json(
      { error: 'Failed to create RAG collection' },
      { status: 500 }
    )
  }
}