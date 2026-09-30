import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { z } from 'zod';
import {
  parseBody,
  parseQuery,
  paginationQuery,
  buildWhereClause,
  buildOrderBy,
  paginatedResponse,
} from '@/lib/validators';

const createSchema = z.object({
  agentId: z.string().min(1),
  period: z.string().default('daily'),
  totalRuns: z.number().int().default(0),
  successCount: z.number().int().default(0),
  failureCount: z.number().int().default(0),
  avgRuntimeMs: z.number().int().default(0),
  totalTokensUsed: z.number().int().default(0),
});

const updateSchema = z.object({
  agentId: z.string().min(1).optional(),
  period: z.string().optional(),
  totalRuns: z.number().int().optional(),
  successCount: z.number().int().optional(),
  failureCount: z.number().int().optional(),
  avgRuntimeMs: z.number().int().optional(),
  totalTokensUsed: z.number().int().optional(),
});

export async function GET(request: NextRequest) {
  const authHeader = request.headers.get('authorization');
  const token = authHeader?.replace('Bearer ', '');
  if (!token) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const { verifySessionToken } = await import('@/lib/auth');
  const session = await verifySessionToken(token);
  if (!session) return NextResponse.json({ error: 'Invalid token' }, { status: 401 });

  try {
    const parsed = parseQuery(paginationQuery, request.nextUrl.searchParams);
    if (parsed.error) return NextResponse.json({ error: parsed.error.message }, { status: parsed.error.status });
    const { page, limit, sort, order, search } = parsed.data;

    const where = buildWhereClause(['period'], search);
    const orderBy = buildOrderBy(sort, order);

    const [records, total] = await Promise.all([
      db.agentUsageSummary.findMany({ where, skip: (page - 1) * limit, take: limit, orderBy }),
      db.agentUsageSummary.count({ where }),
    ]);

    return NextResponse.json(paginatedResponse(records, page, limit, total));
  } catch (error) {
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  const authHeader = request.headers.get('authorization');
  const token = authHeader?.replace('Bearer ', '');
  if (!token) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const { verifySessionToken } = await import('@/lib/auth');
  const session = await verifySessionToken(token);
  if (!session) return NextResponse.json({ error: 'Invalid token' }, { status: 401 });

  try {
    const body = await request.json();
    const parsed = parseBody(createSchema, body);
    if (parsed.error) return NextResponse.json({ error: parsed.error.message }, { status: parsed.error.status });

    const record = await db.agentUsageSummary.create({ data: parsed.data });

    await db.auditLog.create({
      data: { action: 'create', resource: 'AgentUsageSummary', details: JSON.stringify({ id: record.id }), userId: session.userId },
    });

    return NextResponse.json({ data: record }, { status: 201 });
  } catch (error) {
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

export async function PUT(request: NextRequest) {
  const authHeader = request.headers.get('authorization');
  const token = authHeader?.replace('Bearer ', '');
  if (!token) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const { verifySessionToken } = await import('@/lib/auth');
  const session = await verifySessionToken(token);
  if (!session) return NextResponse.json({ error: 'Invalid token' }, { status: 401 });

  try {
    const body = await request.json();
    const { id, ...fields } = body;
    if (!id) return NextResponse.json({ error: 'id is required' }, { status: 400 });

    const parsed = parseBody(updateSchema, fields);
    if (parsed.error) return NextResponse.json({ error: parsed.error.message }, { status: parsed.error.status });

    const existing = await db.agentUsageSummary.findUnique({ where: { id } });
    if (!existing) return NextResponse.json({ error: 'Not found' }, { status: 404 });

    const record = await db.agentUsageSummary.update({ where: { id }, data: parsed.data });

    await db.auditLog.create({
      data: { action: 'update', resource: 'AgentUsageSummary', details: JSON.stringify({ id, changes: parsed.data }), userId: session.userId },
    });

    return NextResponse.json({ data: record });
  } catch (error) {
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

export async function DELETE(request: NextRequest) {
  const authHeader = request.headers.get('authorization');
  const token = authHeader?.replace('Bearer ', '');
  if (!token) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const { verifySessionToken } = await import('@/lib/auth');
  const session = await verifySessionToken(token);
  if (!session) return NextResponse.json({ error: 'Invalid token' }, { status: 401 });

  try {
    const { searchParams } = new URL(request.url);
    const id = searchParams.get('id');
    if (!id) return NextResponse.json({ error: 'id is required' }, { status: 400 });

    const existing = await db.agentUsageSummary.findUnique({ where: { id } });
    if (!existing) return NextResponse.json({ error: 'Not found' }, { status: 404 });

    await db.agentUsageSummary.delete({ where: { id } });

    await db.auditLog.create({
      data: { action: 'delete', resource: 'AgentUsageSummary', details: JSON.stringify({ id }), userId: session.userId },
    });

    return NextResponse.json({ success: true });
  } catch (error) {
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
