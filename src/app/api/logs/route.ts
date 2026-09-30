import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'

// ──────────────────────────────────────────────
// Type definitions
// ──────────────────────────────────────────────

const VALID_LOG_LEVELS = ['debug', 'info', 'warn', 'warning', 'error', 'fatal']

interface LogEntry {
  level: string
  message: string
  source?: string
  metadata?: Record<string, unknown>
  agentId?: string
  companyId?: string
}

// ──────────────────────────────────────────────
// POST /api/logs — ingest a log entry
// ──────────────────────────────────────────────

export async function POST(request: NextRequest) {
  // Auth check
  const authHeader = request.headers.get('authorization');
  const token = authHeader?.replace('Bearer ', '');
  if (!token) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const { verifySessionToken } = await import('@/lib/auth');
  const session = await verifySessionToken(token);
  if (!session) return NextResponse.json({ error: 'Invalid token' }, { status: 401 });
  try {
    const body = (await request.json()) as LogEntry
    const { level, message, source, metadata, agentId, companyId } = body

    if (!level || !VALID_LOG_LEVELS.includes(level)) {
      return NextResponse.json(
        { error: `level is required and must be one of: ${VALID_LOG_LEVELS.join(', ')}` },
        { status: 400 },
      )
    }

    if (!message || typeof message !== 'string') {
      return NextResponse.json({ error: 'message is required and must be a string' }, { status: 400 })
    }

    // Normalize "warning" → "warn" for consistency
    const normalizedLevel = level === 'warning' ? 'warn' : level

    // Build the metadata object, embedding source/agentId/companyId
    const enrichedMetadata: Record<string, unknown> = { ...metadata }
    if (source) enrichedMetadata.source = source
    if (agentId) enrichedMetadata.agentId = agentId
    if (companyId) enrichedMetadata.companyId = companyId

    // Create ServerLog entry
    const log = await db.serverLog.create({
      data: {
        level: normalizedLevel,
        message,
        metadata: JSON.stringify(enrichedMetadata),
      },
    })

    // If level is 'error' or 'fatal', also create an ErrorLog entry
    if (normalizedLevel === 'error' || normalizedLevel === 'fatal') {
      await db.errorLog.create({
        data: {
          source: source || 'unknown',
          message,
          stack: typeof metadata?.stack === 'string' ? (metadata.stack as string) : null,
          severity: normalizedLevel === 'fatal' ? 'critical' : 'error',
        },
      })
    }

    return NextResponse.json(
      {
        data: {
          id: log.id,
          level: log.level,
          message: log.message,
          createdAt: log.createdAt.toISOString(),
        },
      },
      { status: 201 },
    )
  } catch (error) {
    console.error('Error ingesting log:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

// ──────────────────────────────────────────────
// GET /api/logs — query logs with filtering
// ──────────────────────────────────────────────

export async function GET(request: NextRequest) {
  // Auth check
  const authHeader = request.headers.get('authorization');
  const token = authHeader?.replace('Bearer ', '');
  if (!token) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const { verifySessionToken } = await import('@/lib/auth');
  const session = await verifySessionToken(token);
  if (!session) return NextResponse.json({ error: 'Invalid token' }, { status: 401 });
  try {
    const { searchParams } = new URL(request.url)

    const level = searchParams.get('level')
    const source = searchParams.get('source')
    const from = searchParams.get('from')
    const to = searchParams.get('to')
    const limit = Math.min(500, Math.max(1, parseInt(searchParams.get('limit') || '100')))
    const offset = Math.max(0, parseInt(searchParams.get('offset') || '0'))

    // Build where clause
    const where: Record<string, unknown> = {}

    if (level) {
      const normalizedLevel = level === 'warning' ? 'warn' : level
      if (VALID_LOG_LEVELS.includes(normalizedLevel)) {
        where.level = normalizedLevel
      }
    }

    // Filter by source embedded in metadata JSON (SQLite contains search)
    if (source) {
      where.metadata = { contains: `"source":"${source}"` }
    }

    // Time range filtering
    if (from || to) {
      where.createdAt = {}
      if (from) (where.createdAt as Record<string, unknown>).gte = new Date(from)
      if (to) (where.createdAt as Record<string, unknown>).lte = new Date(to)
    }

    const [logs, total] = await Promise.all([
      db.serverLog.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        take: limit,
        skip: offset,
      }),
      db.serverLog.count({ where }),
    ])

    const data = logs.map((log) => {
      let parsedMetadata: Record<string, unknown> = {}
      try {
        parsedMetadata = JSON.parse(log.metadata)
      } catch {
        // Keep empty
      }

      return {
        id: log.id,
        level: log.level,
        message: log.message,
        source: (parsedMetadata.source as string) || null,
        agentId: (parsedMetadata.agentId as string) || null,
        companyId: (parsedMetadata.companyId as string) || null,
        metadata: parsedMetadata,
        createdAt: log.createdAt.toISOString(),
      }
    })

    return NextResponse.json({
      data,
      pagination: {
        total,
        limit,
        offset,
        hasMore: offset + limit < total,
      },
    })
  } catch (error) {
    console.error('Error querying logs:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

// ──────────────────────────────────────────────
// DELETE /api/logs — prune old logs
// ──────────────────────────────────────────────

export async function DELETE(request: NextRequest) {
  // Auth check
  const authHeader = request.headers.get('authorization');
  const token = authHeader?.replace('Bearer ', '');
  if (!token) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const { verifySessionToken } = await import('@/lib/auth');
  const session = await verifySessionToken(token);
  if (!session) return NextResponse.json({ error: 'Invalid token' }, { status: 401 });
  try {
    const { searchParams } = new URL(request.url)
    const olderThan = searchParams.get('olderThan')

    if (!olderThan) {
      return NextResponse.json(
        { error: 'olderThan query parameter is required (ISO date string)' },
        { status: 400 },
      )
    }

    const cutoff = new Date(olderThan)
    if (isNaN(cutoff.getTime())) {
      return NextResponse.json({ error: 'Invalid date format for olderThan' }, { status: 400 })
    }

    // Delete ServerLog entries older than cutoff
    const serverLogResult = await db.serverLog.deleteMany({
      where: { createdAt: { lt: cutoff } },
    })

    // Delete ErrorLog entries older than cutoff
    const errorLogResult = await db.errorLog.deleteMany({
      where: { createdAt: { lt: cutoff } },
    })

    return NextResponse.json({
      data: {
        serverLogsDeleted: serverLogResult.count,
        errorLogsDeleted: errorLogResult.count,
        totalDeleted: serverLogResult.count + errorLogResult.count,
        olderThan,
      },
    })
  } catch (error) {
    console.error('Error pruning logs:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}