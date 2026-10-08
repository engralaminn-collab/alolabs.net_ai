import { headers } from 'next/headers'
import { db } from './db'

export interface AuthenticatedUser {
  userId: string
  role: string
  email: string
  name: string
  companyId?: string
  companyRole?: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export async function getAuthUser(): Promise<AuthenticatedUser | null> {
  const headersList = await headers()
  const authHeader = headersList.get('authorization')
  if (!authHeader?.startsWith('Bearer ')) return null

  const token = authHeader.slice('Bearer '.length)
  if (!token) return null

  try {
    const session = await db.settings.findUnique({ where: { key: `session:${token}` } })
    if (!session) return null

    const parsed: unknown = JSON.parse(session.value)
    if (!isRecord(parsed)) return null
    const sessionUserId = typeof parsed.userId === 'string'
      ? parsed.userId
      : typeof parsed.id === 'string'
        ? parsed.id
        : undefined
    if (!sessionUserId) return null

    const user = await db.user.findUnique({
      where: { id: sessionUserId },
      select: { id: true, email: true, name: true, role: true, isActive: true },
    })
    if (!user || !user.isActive) return null

    const memberships = await db.companyUser.findMany({
      where: { userId: user.id },
      select: { companyId: true, role: true },
    })
    const requestedCompanyId = headersList.get('x-company-id') ?? undefined
    const requestedCompanySlug = headersList.get('x-company-slug') ?? undefined
    let companyId: string | undefined

    if (requestedCompanyId) {
      if (!memberships.some((membership) => membership.companyId === requestedCompanyId)) return null
      companyId = requestedCompanyId
    } else if (requestedCompanySlug) {
      const selectedCompany = await db.company.findUnique({
        where: { slug: requestedCompanySlug },
        select: { id: true },
      })
      if (!selectedCompany || !memberships.some((membership) => membership.companyId === selectedCompany.id)) return null
      companyId = selectedCompany.id
    } else if (memberships.length === 1) {
      companyId = memberships[0].companyId
    }

    const selectedMembership = companyId
      ? memberships.find((membership) => membership.companyId === companyId)
      : undefined

    return {
      userId: user.id,
      role: user.role,
      email: user.email,
      name: user.name,
      ...(companyId ? { companyId } : {}),
      ...(selectedMembership ? { companyRole: selectedMembership.role } : {}),
    }
  } catch {
    return null
  }
}

export async function requireAuth(): Promise<AuthenticatedUser> {
  const user = await getAuthUser()
  if (!user) throw new Error('Unauthorized')
  return user
}

export async function requireCompanyAuth(): Promise<AuthenticatedUser & { companyId: string }> {
  const user = await requireAuth()
  const companyId = user.companyId
  if (!companyId) throw new Error('Forbidden')
  return { ...user, companyId }
}

export async function requireCompanyRole(...roles: string[]): Promise<AuthenticatedUser & { companyId: string; companyRole: string }> {
  const user = await requireCompanyAuth()
  const companyRole = user.companyRole
  if (!companyRole || !roles.includes(companyRole)) throw new Error('Forbidden')
  return { ...user, companyRole }
}

export async function requireRole(...roles: string[]): Promise<AuthenticatedUser> {
  const user = await requireAuth()
  if (!roles.includes(user.role)) throw new Error('Forbidden')
  return user
}
