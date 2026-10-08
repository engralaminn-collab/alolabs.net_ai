import { PrismaClient } from '@prisma/client'

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined
}

/**
 * ALO Labs AgentOS — Prisma client singleton.
 *
 * Production (default): the standard library query engine, configured entirely
 * through DATABASE_URL. Nothing changes.
 *
 * Air-gapped / engine-less environments (PRISMA_SQLITE_ADAPTER=1):
 * Uses the WASM query compiler with the better-sqlite3 driver adapter, so the
 * app runs without downloading Prisma engine binaries. Requires the client to
 * have been generated with `engineType = "client"` (see
 * scripts/dev-generate-client.sh) and `better-sqlite3` installed.
 */
function createPrismaClient(): PrismaClient {
  if (process.env.PRISMA_SQLITE_ADAPTER === '1') {
    // Lazy require so production (library engine) never loads the adapter.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { PrismaBetterSQLite3 } = require('@prisma/adapter-better-sqlite3') as typeof import('@prisma/adapter-better-sqlite3')
    const url = process.env.DATABASE_URL ?? 'file:./db/custom.db'
    return new PrismaClient({
      log: ['error'],
      adapter: new PrismaBetterSQLite3({ url }),
    })
  }
  return new PrismaClient({
    log: ['error'],
  })
}

export const db =
  globalForPrisma.prisma ??
  createPrismaClient()

if (process.env.NODE_ENV !== 'production') globalForPrisma.prisma = db
