import { z } from 'zod';
import { v1Handler, v1Body, V1Error } from '@/lib/v1';
import { db } from '@/lib/db';
import { recordRunEvent } from '@/lib/runs';

/**
 * /api/v1/approvals/:id — approve or reject (POST with action), or read (GET).
 * Approvals are recorded in the audit log; the run waiting on the approval
 * is resumed or failed accordingly.
 */

const ActionSchema = z.object({
  action: z.enum(['approve', 'reject']),
  note: z.string().max(2000).optional(),
});

async function loadApproval(id: string, companyId: string) {
  const approval = await db.approval.findUnique({ where: { id } });
  if (!approval) throw new V1Error('Approval not found', 404, 'NOT_FOUND');
  if (approval.companyId !== companyId) {
    throw new V1Error('Forbidden', 403, 'FORBIDDEN');
  }
  return approval;
}

export const GET = v1Handler(async ({ identity }, request) => {
  const id = decodeURIComponent(request.nextUrl.pathname.split('/').pop()!);
  return loadApproval(id, identity.companyId);
});

export const POST = v1Handler(async ({ identity }, request) => {
  if (identity.kind !== 'session' || !['admin', 'super_admin', 'manager'].includes(identity.role)) {
    throw new V1Error('Human approval requires an authorized administrator session', 403, 'FORBIDDEN');
  }
  const id = decodeURIComponent(request.nextUrl.pathname.split('/').pop()!);
  const approval = await loadApproval(id, identity.companyId);
  if (approval.status !== 'pending') {
    throw new V1Error(`Approval is already ${approval.status}`, 409, 'CONFLICT');
  }

  const body = await v1Body<unknown>(request);
  const parsed = ActionSchema.safeParse(body);
  if (!parsed.success) {
    throw new V1Error('Validation failed: ' + parsed.error.issues.map((i) => i.message).join('; '), 400, 'VALIDATION_ERROR');
  }

  const approved = parsed.data.action === 'approve';
  const updated = await db.approval.update({
    where: { id: approval.id },
    data: {
      status: approved ? 'approved' : 'rejected',
      reviewedBy: identity.userId,
      reviewedAt: new Date(),
      responseNote: parsed.data.note ?? null,
    },
  });

  // Resume or fail the waiting run, if any
  let runId: string | null = null;
  try {
    const requestJson = JSON.parse(approval.requestJson || '{}') as { runId?: string };
    runId = typeof requestJson.runId === 'string' ? requestJson.runId : null;
  } catch { /* no run link */ }

  if (runId) {
    // A QC approval acknowledges the reviewed output; it is NOT a new
    // execution. Do not mark the run "running" without a queued worker —
    // that would create a permanently stuck, falsely active run. The run
    // remains paused until a real resume path is implemented.
    if (!approved) {
      await db.agentOSRun.update({
        where: { id: runId },
        data: { status: 'failed', error: `Human review rejected: ${parsed.data.note ?? 'no note'}`, completedAt: new Date() },
      });
    } else {
      await db.agentOSRun.update({
        where: { id: runId },
        data: { summary: 'Human review approved. Manual continuation is required; this run has not resumed.' },
      });
    }
    await recordRunEvent({
      runId,
      type: approved ? 'approval.approved' : 'run.failed',
      source: 'approval',
      data: { approvalId: approval.id, approved, note: parsed.data.note ?? null },
    });
  }

  // Audit log
  await db.auditLog.create({
    data: {
      userId: identity.userId,
      action: approved ? 'approve' : 'reject',
      resource: 'approvals',
      details: JSON.stringify({ approvalId: approval.id, note: parsed.data.note ?? null, runId }),
    },
  }).catch(() => {});

  return {
    approval: updated,
    resumedRunId: null,
    ...(approved && runId ? { continuationRequired: true, message: 'Human review recorded. Automatic continuation is not yet available.' } : {}),
  };
});
