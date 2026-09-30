import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';

// GET /api/company-access — get access matrix or list domains/IPs
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
    const companyId = searchParams.get('companyId');
    const section = searchParams.get('section');

    // Handle domain/IP listing
    if (companyId && section === 'domains') {
      const domains = await db.companyDomain.findMany({
        where: { companyId },
        orderBy: { createdAt: 'desc' },
      });
      return NextResponse.json({ data: domains });
    }

    if (companyId && section === 'ips') {
      const ips = await db.companyIpAllowlist.findMany({
        where: { companyId },
        orderBy: { createdAt: 'desc' },
      });
      return NextResponse.json({ data: ips });
    }

    // Default: access matrix
    const companies = await db.company.findMany({
      orderBy: { createdAt: 'asc' },
    });

    const permissions = await db.companyPermission.findMany({
      include: {
        company: { select: { slug: true, name: true } },
      },
    });

    // Build access matrix from permissions
    const matrix: Record<string, Record<string, string>> = {};

    for (const comp of companies) {
      matrix[comp.slug] = {};
    }

    // Map department slugs to group names
    const deptGroupMap: Record<string, string> = {
      'ai-ops': 'AI Ops',
      'content-creation': 'Content',
      'business-intelligence': 'Business',
      'business-operations': 'Business',
      'education': 'Education',
      'language-learning': 'Education',
      'software-development': 'Dev',
      'devops': 'Dev',
      'sales': 'Sales',
      'marketing': 'Sales',
      'human-resources': 'HR',
      'finance-accounting': 'Finance',
      'security': 'Security',
      'compliance': 'Security',
      'research-analytics': 'Research',
    };

    for (const perm of permissions) {
      const slug = perm.company.slug
      if (!matrix[slug]) matrix[slug] = {};

      const dept = perm.departmentId ? await db.department.findUnique({ where: { id: perm.departmentId } }) : null;
      const groupName = dept ? (deptGroupMap[dept.slug] || dept.name) : 'General';

      // If any permission exists, it's at least 'read'. 'write'/'execute'/'admin' -> 'full'
      const existingLevel = matrix[slug][groupName];
      if (perm.accessLevel === 'admin' || perm.accessLevel === 'execute' || perm.accessLevel === 'write') {
        matrix[slug][groupName] = 'full';
      } else if (!existingLevel || existingLevel === 'none') {
        matrix[slug][groupName] = 'read';
      }
    }

    return NextResponse.json({ matrix });
  } catch (error) {
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

// PATCH /api/company-access — update access level
export async function PATCH(request: NextRequest) {
  // Auth check
  const authHeader = request.headers.get('authorization');
  const token = authHeader?.replace('Bearer ', '');
  if (!token) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const { verifySessionToken } = await import('@/lib/auth');
  const session = await verifySessionToken(token);
  if (!session) return NextResponse.json({ error: 'Invalid token' }, { status: 401 });
  try {
    const body = await request.json();
    const { companyId, group, accessLevel } = body;

    if (!companyId || !group || !accessLevel) {
      return NextResponse.json({ error: 'companyId, group, and accessLevel are required' }, { status: 400 });
    }

    // Find the company
    const company = await db.company.findUnique({ where: { id: companyId } });
    if (!company) {
      return NextResponse.json({ error: 'Company not found' }, { status: 404 });
    }

    if (company.slug === 'alo-labs') {
      return NextResponse.json({ error: 'Cannot modify ALO Labs (owner) access' }, { status: 403 });
    }

    // Map group back to department slugs
    const groupDeptMap: Record<string, string[]> = {
      'AI Ops': ['ai-ops'],
      'Content': ['content-creation'],
      'Business': ['business-intelligence', 'business-operations'],
      'Education': ['education', 'language-learning'],
      'Dev': ['software-development', 'devops'],
      'Sales': ['sales', 'marketing'],
      'HR': ['human-resources'],
      'Finance': ['finance-accounting'],
      'Security': ['security', 'compliance'],
      'Research': ['research-analytics'],
    };

    const deptSlugs = groupDeptMap[group] || [];

    if (accessLevel === 'none') {
      // Remove all permissions for this company + department group
      for (const slug of deptSlugs) {
        const dept = await db.department.findUnique({ where: { slug } });
        if (dept) {
          await db.companyPermission.deleteMany({
            where: { companyId, departmentId: dept.id },
          });
        }
      }
    } else {
      // Grant permissions
      const level = accessLevel === 'full' ? 'execute' : 'read';
      for (const slug of deptSlugs) {
        const dept = await db.department.findUnique({ where: { slug } });
        if (dept) {
          // Upsert: delete existing, create new
          await db.companyPermission.deleteMany({
            where: { companyId, departmentId: dept.id },
          });
          await db.companyPermission.create({
            data: {
              companyId,
              departmentId: dept.id,
              accessLevel: level,
            },
          });
        }
      }
    }

    return NextResponse.json({ success: true });
  } catch (error) {
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

// POST /api/company-access — add domain or IP allowlist entry
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
    const { action } = body;

    if (action === 'add-domain') {
      const { companyId, domain, isPrimary } = body;
      if (!companyId || !domain) {
        return NextResponse.json({ error: 'companyId and domain are required' }, { status: 400 });
      }

      const company = await db.company.findUnique({ where: { id: companyId } });
      if (!company) {
        return NextResponse.json({ error: 'Company not found' }, { status: 404 });
      }

      const record = await db.companyDomain.create({
        data: {
          companyId,
          domain,
          isPrimary: isPrimary || false,
          verificationStatus: 'pending',
        },
      });

      return NextResponse.json({ success: true, data: record }, { status: 201 });
    }

    if (action === 'add-ip') {
      const { companyId, cidr, description } = body;
      if (!companyId || !cidr) {
        return NextResponse.json({ error: 'companyId and cidr are required' }, { status: 400 });
      }

      const company = await db.company.findUnique({ where: { id: companyId } });
      if (!company) {
        return NextResponse.json({ error: 'Company not found' }, { status: 404 });
      }

      const record = await db.companyIpAllowlist.create({
        data: {
          companyId,
          cidr,
          description: description || null,
        },
      });

      return NextResponse.json({ success: true, data: record }, { status: 201 });
    }

    return NextResponse.json({ error: `Unknown action: ${action}` }, { status: 400 });
  } catch (error) {
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

// DELETE /api/company-access — remove domain or IP allowlist entry
export async function DELETE(request: NextRequest) {
  // Auth check
  const authHeader = request.headers.get('authorization');
  const token = authHeader?.replace('Bearer ', '');
  if (!token) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const { verifySessionToken } = await import('@/lib/auth');
  const session = await verifySessionToken(token);
  if (!session) return NextResponse.json({ error: 'Invalid token' }, { status: 401 });
  try {
    const body = await request.json();
    const { action, id } = body;

    if (!id) {
      return NextResponse.json({ error: 'id is required' }, { status: 400 });
    }

    if (action === 'remove-domain') {
      const record = await db.companyDomain.findUnique({ where: { id } });
      if (!record) {
        return NextResponse.json({ error: 'Domain record not found' }, { status: 404 });
      }
      await db.companyDomain.delete({ where: { id } });
      return NextResponse.json({ success: true });
    }

    if (action === 'remove-ip') {
      const record = await db.companyIpAllowlist.findUnique({ where: { id } });
      if (!record) {
        return NextResponse.json({ error: 'IP allowlist record not found' }, { status: 404 });
      }
      await db.companyIpAllowlist.delete({ where: { id } });
      return NextResponse.json({ success: true });
    }

    return NextResponse.json({ error: `Unknown action: ${action}` }, { status: 400 });
  } catch (error) {
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}