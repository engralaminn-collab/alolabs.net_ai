import { NextRequest, NextResponse } from 'next/server'
import { requireAuth } from '@/lib/api-auth'
import { getMarketingSkill, skillTriggers } from '@/lib/marketing-kit'
import { referenceDoc, skillBody, skillWithBody } from '@/lib/marketing-kit/content'

/**
 * GET /api/marketing-kit/:slug            → metadata + full playbook body
 * GET /api/marketing-kit/:slug?ref=<path> → one reference document
 */
export async function GET(request: NextRequest, { params }: { params: Promise<{ slug: string }> }) {
  try {
    await requireAuth()
    const { slug } = await params
    const { searchParams } = new URL(request.url)
    const ref = searchParams.get('ref')

    const skill = getMarketingSkill(slug)
    if (!skill) {
      return NextResponse.json({ error: 'Skill not found' }, { status: 404 })
    }

    if (ref) {
      const doc = referenceDoc(slug, ref)
      if (!doc) return NextResponse.json({ error: 'Reference not found' }, { status: 404 })
      return NextResponse.json({ slug, reference: doc })
    }

    const withBody = skillWithBody(slug)
    if (!withBody) {
      return NextResponse.json({ error: 'Playbook body missing — re-run scripts/sync-marketing-kit.mjs' }, { status: 500 })
    }

    return NextResponse.json({
      ...withBody,
      body: withBody.body,
      triggers: skillTriggers(skill),
      hasBody: Boolean(skillBody(slug)),
    })
  } catch (error: unknown) {
    if (error instanceof Error && error.message === 'Unauthorized') {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }
    console.error('Marketing kit detail error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
