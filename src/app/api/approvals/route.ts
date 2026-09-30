import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { Prisma } from '@prisma/client';

export async function GET(request: NextRequest) {
  // Auth check
  const authHeader = request.headers.get('authorization');
  const token = authHeader?.replace('Bearer ', '');
  if (!token) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const { verifySessionToken } = await import('@/lib/auth');
  const session = await verifySessionToken(token);
  if (!session) return NextResponse.json({ error: 'Invalid token' }, { status: 401 });
  try {
    const { searchParams } = new URL(request.url);
    const page = Math.max(1, parseInt(searchParams.get('page') || '1'));
    const limit = Math.min(100, Math.max(1, parseInt(searchParams.get('limit') || '20')));
    const statusFilter = searchParams.get('status') || '';

    const where: Prisma.ApprovalWhereInput = statusFilter && statusFilter !== 'all'
      ? { status: statusFilter }
      : {};

    const [approvals, total] = await Promise.all([
      db.approval.findMany({
        where,
        skip: (page - 1) * limit,
        take: limit,
        orderBy: { createdAt: 'desc' },
        include: {
          user: { select: { id: true, name: true, email: true } },
        },
      }),
      db.approval.count({ where }),
    ]);

    const data = approvals.map((a) => ({
      id: a.id,
      type: a.type,
      title: a.title,
      description: a.description,
      status: a.status,
      user: a.user ? { name: a.user.name, email: a.user.email } : undefined,
      createdAt: a.createdAt.toISOString(),
    }));

    return NextResponse.json({ data, total, page, limit, totalPages: Math.ceil(total / limit) });
  } catch (error) {
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

export async function PUT(request: NextRequest) {
  // Auth check
  const authHeader = request.headers.get('authorization');
  const token = authHeader?.replace('Bearer ', '');
  if (!token) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const { verifySessionToken } = await import('@/lib/auth');
  const session = await verifySessionToken(token);
  if (!session) return NextResponse.json({ error: 'Invalid token' }, { status: 401 });
  try {
    const { searchParams } = new URL(request.url);
    const action = searchParams.get('action');
    const body = await request.json();
    const { approvalId } = body;

    if (!approvalId || !action) {
      return NextResponse.json({ error: 'approvalId and action are required' }, { status: 400 });
    }

    const newStatus = action === 'approve' ? 'approved' : 'rejected';

    const approval = await db.approval.update({
      where: { id: approvalId },
      data: {
        status: newStatus,
        reviewedBy: 'admin',
        reviewedAt: new Date(),
      },
    });

    return NextResponse.json({ success: true, status: approval.status });
  } catch (error) {
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
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
    const body = await request.json();
    const { type, title, description, requestedBy } = body;

    if (!type || !title) {
      return NextResponse.json({ error: 'type and title are required' }, { status: 400 });
    }

    const approval = await db.approval.create({
      data: {
        type,
        title,
        description: description || '',
        requestedBy: requestedBy || null,
      },
    });

    return NextResponse.json({ id: approval.id, type: approval.type, title: approval.title, status: approval.status }, { status: 201 });
  } catch (error) {
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}