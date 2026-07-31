'use client'
import { useState } from 'react'
import Link from 'next/link'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'

const VERDICT_LABEL: Record<string, string> = {
  accept: 'Accept',
  minor_revision: 'Minor revision',
  major_revision: 'Major revision',
  reject: 'Reject',
}

export function ReviewTopBar({
  reviewNumber, verdict, score, sessionId, manuscriptId, onOpenPdf,
}: {
  reviewNumber: number
  verdict?: string
  score: number
  sessionId: string
  manuscriptId: string
  onOpenPdf: () => void
}) {
  const [exportError, setExportError] = useState<string | null>(null)

  // Fetch rather than a plain `<a download>`: the route is plan-gated, and a
  // bare anchor would save the 403 JSON body to disk as a ".xlsx" the user
  // can't open. Going through fetch lets the upgrade message actually surface.
  async function handleExport() {
    setExportError(null)
    try {
      const res = await fetch(`/api/export/${sessionId}`)
      if (!res.ok) {
        const body = await res.json().catch(() => null)
        throw new Error(body?.error ?? `Export failed (${res.status})`)
      }
      const url = URL.createObjectURL(await res.blob())
      const a = document.createElement('a')
      a.href = url
      a.download = `scholarlens-review-${sessionId}.xlsx`
      a.click()
      URL.revokeObjectURL(url)
    } catch (e) {
      setExportError(e instanceof Error ? e.message : 'Export failed')
    }
  }

  return (
    <div className="flex flex-wrap items-center gap-3 rounded-lg border bg-card px-4 py-3">
      <span className="rounded-full border px-2.5 py-1 text-xs font-medium text-muted-foreground">
        Review {reviewNumber}
      </span>
      <Badge>{VERDICT_LABEL[verdict ?? ''] ?? verdict}</Badge>
      <span className="text-lg font-semibold">{score} / 80</span>
      <div className="ml-auto flex items-center gap-2">
        <Button variant="outline" size="sm" onClick={onOpenPdf}>PDF report</Button>
        <Button variant="outline" size="sm" onClick={handleExport}>.xlsx</Button>
        <Button asChild size="sm">
          <Link href={`/manuscripts/${manuscriptId}/upload`}>Upload revision</Link>
        </Button>
      </div>
      {exportError && (
        <p className="w-full text-right text-sm text-destructive">{exportError}</p>
      )}
    </div>
  )
}
