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
    const search = searchParams.get('search') || '';
    const department = searchParams.get('department') || '';
    const role = searchParams.get('role') || '';
    const status = searchParams.get('status') || '';
    const page = Math.max(1, parseInt(searchParams.get('page') || '1'));
    const limit = Math.min(100, Math.max(1, parseInt(searchParams.get('limit') || '50')));

    const where: Prisma.AgentWhereInput = {};

    if (search) {
      where.name = { contains: search };
    }
    if (department) {
      where.department = { slug: department };
    }
    if (role) {
      where.role = role;
    }
    if (status) {
      where.status = status;
    }

    const [agents, total] = await Promise.all([
      db.agent.findMany({
        where,
        skip: (page - 1) * limit,
        take: limit,
        orderBy: { agentId: 'asc' },
        select: {
          id: true,
          agentId: true,
          name: true,
          slug: true,
          departmentName: true,
          role: true,
          status: true,
          version: true,
          purpose: true,
          department: { select: { slug: true } },
        },
      }),
      db.agent.count({ where }),
    ]);

    const data = agents.map((a) => ({
      id: a.id,
      agentId: a.agentId,
      name: a.name,
      slug: a.slug,
      departmentName: a.departmentName,
      role: a.role,
      status: a.status,
      version: a.version,
      purpose: a.purpose,
    }));

    return NextResponse.json({
      data,
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
    });
  } catch (error) {
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}