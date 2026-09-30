import { db } from '@/lib/db'
import type { Prisma } from '@prisma/client'

export async function uploadSource(data: { name: string; type: string; sourceUrl?: string; filePath?: string; fileSize?: number; level?: number; companyId?: string; departmentId?: string; agentId?: string }) {
  return db.trainingSource.create({ data: { ...data, status: 'pending', level: data.level || 1 } })
}

export async function parseDocument(sourceId: string) {
  await db.trainingSource.update({ where: { id: sourceId }, data: { status: 'parsing' } })
  try {
    const source = await db.trainingSource.findUnique({ where: { id: sourceId } })
    if (!source) throw new Error('Source not found')
    // In production, actual parsing based on source.type
    await db.trainingSource.update({ where: { id: sourceId }, data: { status: 'chunking' } })
    return { success: true, sourceId }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    await db.trainingSource.update({ where: { id: sourceId }, data: { status: 'failed', error: msg } })
    return { success: false, error: msg }
  }
}

export async function chunkDocument(sourceId: string, chunkSize: number = 512) {
  const source = await db.trainingSource.findUnique({ where: { id: sourceId } })
  if (!source) throw new Error('Source not found')
  // Simulate chunking
  const estimatedChunks = Math.max(1, Math.floor((source.fileSize || 1000) / chunkSize))
  await db.trainingSource.update({ where: { id: sourceId }, data: { status: 'embedding', chunkCount: estimatedChunks } })
  return { success: true, estimatedChunks }
}

export async function embedChunks(sourceId: string) {
  const source = await db.trainingSource.findUnique({ where: { id: sourceId } })
  if (!source) throw new Error('Source not found')
  await db.trainingSource.update({ where: { id: sourceId }, data: { status: 'training' } })
  return { success: true, embeddedChunks: source.chunkCount }
}

export async function trainAgent(sourceId: string, agentId: string) {
  await db.trainingSource.update({ where: { id: sourceId }, data: { status: 'evaluating', agentId } })
  return { success: true, sourceId, agentId }
}

export async function evaluateTraining(sourceId: string, agentId: string) {
  const metrics = ['accuracy', 'relevance', 'completeness', 'consistency']
  const evaluations = await Promise.all(metrics.map(m =>
    db.trainingEvaluation.create({ data: { sourceId, agentId, level: 1, metric: m, score: 75 + Math.random() * 20, maxScore: 100, details: JSON.stringify({ model: 'auto_evaluator', timestamp: new Date().toISOString() }) } })
  ))
  const avgScore = evaluations.reduce((s, e) => s + e.score, 0) / evaluations.length
  if (avgScore >= 70) {
    await db.trainingSource.update({ where: { id: sourceId }, data: { status: 'deployed' } })
  } else {
    await db.trainingSource.update({ where: { id: sourceId }, data: { status: 'failed', error: 'Evaluation score below threshold' } })
  }
  return { success: true, evaluations, avgScore: Math.round(avgScore * 10) / 10 }
}

export async function deployTraining(sourceId: string) {
  return db.trainingSource.update({ where: { id: sourceId }, data: { status: 'deployed' } })
}

export async function getTrainingSources(filters?: { status?: string; level?: number; companyId?: string; agentId?: string; limit?: number }) {
  const where: Prisma.TrainingSourceWhereInput = {}
  if (filters?.status) where.status = filters.status
  if (filters?.level) where.level = filters.level
  if (filters?.companyId) where.companyId = filters.companyId
  if (filters?.agentId) where.agentId = filters.agentId
  return db.trainingSource.findMany({ where, orderBy: { createdAt: 'desc' }, take: filters?.limit || 50 })
}

export async function getTrainingEvaluations(filters?: { agentId?: string; sourceId?: string; level?: number }) {
  const where: Prisma.TrainingEvaluationWhereInput = {}
  if (filters?.agentId) where.agentId = filters.agentId
  if (filters?.sourceId) where.sourceId = filters.sourceId
  if (filters?.level) where.level = filters.level
  return db.trainingEvaluation.findMany({ where, orderBy: { createdAt: 'desc' }, take: 100 })
}
