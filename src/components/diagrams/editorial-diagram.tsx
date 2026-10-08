'use client'

/**
 * EditorialDiagram — the page-level figure.
 *
 * Page layout contract (§7): eyebrow (mono) → title (Instrument Serif) →
 * optional subtitle → the diagram sitting directly on the paper → footer
 * colophon. A framed variant is available for card-heavy layouts, but the
 * default stays borderless so the extra chrome never fights the figure.
 */

import * as React from 'react'
import { DiagramCanvas } from './diagram-canvas'
import { renderDiagram } from '@/lib/diagram-design/render'
import { sceneToHtml, sceneToSvg } from '@/lib/diagram-design/export'
import type { DiagramSpec, DiagramVariant, Theme } from '@/lib/diagram-design/spec'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { CheckCircle2, AlertTriangle, XCircle, Copy, Download } from 'lucide-react'
import { toast } from 'sonner'

export interface EditorialDiagramProps {
  spec: DiagramSpec
  variant?: DiagramVariant
  theme?: Theme
  framed?: boolean
  showAudit?: boolean
  showExport?: boolean
  className?: string
}

export function EditorialDiagram({
  spec,
  variant,
  theme,
  framed = false,
  showAudit = false,
  showExport = false,
  className,
}: EditorialDiagramProps) {
  const resolved: DiagramSpec = React.useMemo(
    () => ({ ...spec, variant: variant ?? spec.variant, theme: theme ?? spec.theme }),
    [spec, variant, theme],
  )
  const scene = React.useMemo(() => renderDiagram(resolved), [resolved])
  const audit = scene.audit
  const dark = resolved.theme === 'dark'

  const copy = async (kind: 'svg' | 'html') => {
    try {
      const payload = kind === 'svg' ? sceneToSvg(scene) : sceneToHtml(scene)
      await navigator.clipboard.writeText(payload)
      toast.success(`${kind.toUpperCase()} copied to clipboard`)
    } catch {
      toast.error('Clipboard unavailable in this browser')
    }
  }

  const download = (kind: 'svg' | 'html') => {
    const payload = kind === 'svg' ? sceneToSvg(scene) : sceneToHtml(scene)
    const blob = new Blob([payload], { type: kind === 'svg' ? 'image/svg+xml' : 'text/html' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `${resolved.slug}.${kind}`
    a.click()
    URL.revokeObjectURL(url)
  }

  return (
    <figure className={cn('w-full', className)} style={{ colorScheme: dark ? 'dark' : 'light' }}>
      <style>{`
        [data-diagram] { --dd-paper: ${dark ? '#2d3142' : '#f5f5f5'}; }
        [data-diagram] text { -webkit-font-smoothing: antialiased; }
        [data-skin="alo"] { --dd-paper: ${dark ? '#0F172A' : '#F8FAFC'}; }
      `}</style>
      <figcaption className="mb-4">
        {resolved.eyebrow && (
          <p className="font-mono text-[10px] font-medium uppercase tracking-[0.18em] text-slate-500">
            {resolved.eyebrow}
          </p>
        )}
        <h3 className="mt-1 font-serif text-2xl font-normal tracking-tight" style={{ fontFamily: 'var(--font-editorial, "Instrument Serif", Georgia, serif)' }}>
          {resolved.title}
        </h3>
        {resolved.subtitle && <p className="mt-1 max-w-[70ch] text-sm text-slate-600">{resolved.subtitle}</p>}
      </figcaption>

      <div
        className={cn(
          framed ? 'rounded-lg border border-slate-200 bg-slate-50 p-6' : '',
          'overflow-hidden',
        )}
      >
        <DiagramCanvas scene={scene} />
      </div>

      {showExport && (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <Button size="sm" variant="outline" onClick={() => copy('svg')}>
            <Copy className="size-3.5" /> Copy SVG
          </Button>
          <Button size="sm" variant="outline" onClick={() => copy('html')}>
            <Copy className="size-3.5" /> Copy HTML
          </Button>
          <Button size="sm" variant="outline" onClick={() => download('svg')}>
            <Download className="size-3.5" /> Save SVG
          </Button>
          <Button size="sm" variant="outline" onClick={() => download('html')}>
            <Download className="size-3.5" /> Save HTML
          </Button>
        </div>
      )}

      {showAudit && audit && (
        <div className="mt-4 rounded-lg border border-slate-200 bg-white p-4">
          <div className="flex items-center gap-2">
            {audit.ok ? (
              <CheckCircle2 className="size-4 text-emerald-600" />
            ) : (
              <XCircle className="size-4 text-red-600" />
            )}
            <span className="text-sm font-medium">
              Taste gate {audit.ok ? 'passed' : 'failed'}
            </span>
            <span className="font-mono text-[10px] uppercase tracking-wider text-slate-500">
              {audit.counts.nodes} nodes · {audit.counts.links} links · {audit.counts.focal} focal
            </span>
          </div>
          <ul className="mt-3 space-y-1">
            {audit.findings.map((f, i) => (
              <li key={i} className="flex items-start gap-2 text-xs text-slate-600">
                {f.level === 'pass' ? (
                  <CheckCircle2 className="mt-0.5 size-3 shrink-0 text-emerald-600" />
                ) : f.level === 'warn' ? (
                  <AlertTriangle className="mt-0.5 size-3 shrink-0 text-amber-500" />
                ) : (
                  <XCircle className="mt-0.5 size-3 shrink-0 text-red-600" />
                )}
                <span>
                  <span className="font-mono text-[10px] uppercase tracking-wide text-slate-400">{f.rule}</span>{' '}
                  {f.message}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {resolved.footer && (
        <p className="mt-3 font-mono text-[10px] uppercase tracking-[0.14em] text-slate-400">{resolved.footer}</p>
      )}
      {!audit?.ok && showAudit && (
        <Badge variant="destructive" className="mt-2">
          Budget breach
        </Badge>
      )}
    </figure>
  )
}

export default EditorialDiagram
