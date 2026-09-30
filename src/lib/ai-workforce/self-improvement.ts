import { db } from '@/lib/db'
import type { Prisma } from '@prisma/client'

export async function proposeOptimization(data: { agentId?: string; type: string; originalValue: Record<string, unknown>; optimizedValue: Record<string, unknown>; improvementPct: number; companyId?: string }) {
  return db.optimizationRecord.create({
    data: {
      agentId: data.agentId,
      type: data.type,
      originalValue: JSON.stringify(data.originalValue),
      optimizedValue: JSON.stringify(data.optimizedValue),
      improvementPct: data.improvementPct,
      status: 'proposed',
      companyId: data.companyId,
    },
  })
}

export async function approveOptimization(id: string, approvedBy: string) {
  return db.optimizationRecord.update({ where: { id }, data: { status: 'approved', approvedBy } })
}

export async function applyOptimization(id: string) {
  const record = await db.optimizationRecord.findUnique({ where: { id } })
  if (!record) throw new Error('Optimization not found')
  if (record.status !== 'approved') throw new Error('Must be approved first')
  return db.optimizationRecord.update({ where: { id }, data: { status: 'applied', appliedAt: new Date() } })
}

export async function rollbackOptimization(id: string) {
  return db.optimizationRecord.update({ where: { id }, data: { status: 'rolled_back' } })
}

export async function evaluateOptimization(id: string, score: number, details?: Record<string, unknown>) {
  return db.optimizationRecord.update({ where: { id }, data: { evaluatedAt: new Date() } })
}

export async function getOptimizations(filters?: { agentId?: string; type?: string; status?: string; companyId?: string; limit?: number }) {
  const where: Prisma.OptimizationRecordWhereInput = {}
  if (filters?.agentId) where.agentId = filters.agentId
  if (filters?.type) where.type = filters.type
  if (filters?.status) where.status = filters.status
  if (filters?.companyId) where.companyId = filters.companyId
  return db.optimizationRecord.findMany({ where, orderBy: { createdAt: 'desc' }, take: filters?.limit || 50 })
}
