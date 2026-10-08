/**
 * Marketing Kit — playbook content (server only).
 *
 * Imports the generated body modules. Route handlers import this file; client
 * components must use `./index` instead so the 2.5MB of markdown stays on the
 * server.
 */

import { SKILL_BODIES } from './data/skills.generated'
import { REFERENCE_BODIES } from './data/references.generated'
import { getMarketingSkill, type MarketingSkill } from './index'

export function skillBody(slug: string): string | undefined {
  return SKILL_BODIES[slug]
}

export interface ReferenceDoc {
  key: string
  heading: string
  content: string
}

export function referenceDoc(slug: string, path: string): ReferenceDoc | undefined {
  const key = `${slug}/${path.startsWith('references/') ? path : `references/${path}`}`
  const doc = REFERENCE_BODIES[key] ?? REFERENCE_BODIES[key.replace(/\.md$/, '')]
  if (!doc) return undefined
  return { key, heading: doc.heading, content: doc.content }
}

export function allReferenceDocs(slug: string): ReferenceDoc[] {
  return Object.entries(REFERENCE_BODIES)
    .filter(([key]) => key.startsWith(`${slug}/`))
    .map(([key, v]) => ({ key, heading: v.heading, content: v.content }))
}

/** A skill plus its body — the shape the detail API returns. */
export function skillWithBody(slug: string): (MarketingSkill & { body: string }) | undefined {
  const skill = getMarketingSkill(slug)
  const body = skillBody(slug)
  if (!skill || !body) return undefined
  return { ...skill, body }
}

export function contentStats() {
  return {
    skills: Object.keys(SKILL_BODIES).length,
    references: Object.keys(REFERENCE_BODIES).length,
    characters: Object.values(SKILL_BODIES).reduce((a, b) => a + b.length, 0),
  }
}
