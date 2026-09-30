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
  workflowId: z.string().optional(),
  title: z.string().min(1),
  description: z.string().optional(),
  status: z.string().default('pending'),
});

const updateSchema = z.object({
  workflowId: z.string().nullable().optional(),
  title: z.string().min(1).optional(),
  description: z.string().optional(),
  status: z.string().optional(),
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

    const where = buildWhereClause(['title', 'description'], search);
    const orderBy = buildOrderBy(sort, order);

    const [records, total] = await Promise.all([
      db.workflowImprovementRequest.findMany({ where, skip: (page - 1) * limit, take: limit, orderBy }),
      db.workflowImprovementRequest.count({ where }),
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

    const record = await db.workflowImprovementRequest.create({ data: parsed.data });

    await db.auditLog.create({
      data: { action: 'create', resource: 'WorkflowImprovementRequest', details: JSON.stringify({ id: record.id }), userId: session.userId },
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

    const existing = await db.workflowImprovementRequest.findUnique({ where: { id } });
    if (!existing) return NextResponse.json({ error: 'Not found' }, { status: 404 });

    const record = await db.workflowImprovementRequest.update({ where: { id }, data: parsed.data });

    await db.auditLog.create({
      data: { action: 'update', resource: 'WorkflowImprovementRequest', details: JSON.stringify({ id, changes: parsed.data }), userId: session.userId },
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

    const existing = await db.workflowImprovementRequest.findUnique({ where: { id } });
    if (!existing) return NextResponse.json({ error: 'Not found' }, { status: 404 });

    await db.workflowImprovementRequest.delete({ where: { id } });

    await db.auditLog.create({
      data: { action: 'delete', resource: 'WorkflowImprovementRequest', details: JSON.stringify({ id }), userId: session.userId },
    });

    return NextResponse.json({ success: true });
  } catch (error) {
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
