import { NextResponse } from 'next/server'
import { pingPostgres } from '@/lib/postgres'
import { pingRedis } from '@/lib/redis'
import { pingQdrant } from '@/lib/qdrant'
import { pingMinio } from '@/lib/minio'

export async function POST() {
  try {
    const [postgresql, redis, qdrant, minio] = await Promise.all([
      pingPostgres().catch((err) => ({
        success: false,
        latencyMs: 0,
        error: err instanceof Error ? err.message : 'Ping failed',
      })),
      pingRedis().catch((err) => ({
        success: false,
        latencyMs: 0,
        error: err instanceof Error ? err.message : 'Ping failed',
      })),
      pingQdrant().catch((err) => ({
        success: false,
        latencyMs: 0,
        error: err instanceof Error ? err.message : 'Ping failed',
      })),
      pingMinio().catch((err) => ({
        success: false,
        latencyMs: 0,
        error: err instanceof Error ? err.message : 'Ping failed',
      })),
    ])

    return NextResponse.json({
      results: {
        postgresql: { success: postgresql.success, latencyMs: postgresql.latencyMs, error: postgresql.error },
        redis: { success: redis.success, latencyMs: redis.latencyMs, error: redis.error },
        qdrant: { success: qdrant.success, latencyMs: qdrant.latencyMs, error: qdrant.error },
        minio: { success: (minio as { success: boolean }).success, latencyMs: (minio as { latencyMs: number }).latencyMs, error: (minio as { error?: string }).error },
      },
    })
  } catch (error) {
    console.error('[Infra Ping] Error:', error)
    return NextResponse.json(
      { error: 'Failed to ping services' },
      { status: 500 }
    )
  }
}