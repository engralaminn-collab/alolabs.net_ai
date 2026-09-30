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
  taskId: z.string().optional(),
  agentId: z.string().optional(),
  toolName: z.string().min(1),
  toolCategory: z.string().min(1),
  input: z.string().default('{}'),
  output: z.string().optional(),
  status: z.string().default('success'),
  durationMs: z.number().optional(),
  blocked: z.boolean().default(false),
  blockReason: z.string().optional(),
});

const updateSchema = z.object({
  taskId: z.string().nullable().optional(),
  agentId: z.string().nullable().optional(),
  toolName: z.string().min(1).optional(),
  toolCategory: z.string().min(1).optional(),
  input: z.string().optional(),
  output: z.string().nullable().optional(),
  status: z.string().optional(),
  durationMs: z.number().nullable().optional(),
  blocked: z.boolean().optional(),
  blockReason: z.string().nullable().optional(),
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

    const where = buildWhereClause(['toolName', 'toolCategory', 'status'], search);
    const orderBy = buildOrderBy(sort, order);

    const [records, total] = await Promise.all([
      db.toolRun.findMany({ where, skip: (page - 1) * limit, take: limit, orderBy }),
      db.toolRun.count({ where }),
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

    const record = await db.toolRun.create({ data: parsed.data });

    await db.auditLog.create({
      data: { action: 'create', resource: 'ToolRun', details: JSON.stringify({ id: record.id }), userId: session.userId },
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

    const existing = await db.toolRun.findUnique({ where: { id } });
    if (!existing) return NextResponse.json({ error: 'Not found' }, { status: 404 });

    const record = await db.toolRun.update({ where: { id }, data: parsed.data });

    await db.auditLog.create({
      data: { action: 'update', resource: 'ToolRun', details: JSON.stringify({ id, changes: parsed.data }), userId: session.userId },
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

    const existing = await db.toolRun.findUnique({ where: { id } });
    if (!existing) return NextResponse.json({ error: 'Not found' }, { status: 404 });

    await db.toolRun.delete({ where: { id } });

    await db.auditLog.create({
      data: { action: 'delete', resource: 'ToolRun', details: JSON.stringify({ id }), userId: session.userId },
    });

    return NextResponse.json({ success: true });
  } catch (error) {
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
