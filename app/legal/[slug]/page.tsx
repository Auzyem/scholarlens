import { notFound } from 'next/navigation'
import type { Metadata } from 'next'
import { MarketingHeader } from '@/components/layout/MarketingHeader'
import { MarketingFooter } from '@/components/layout/MarketingFooter'
import { LegalDocument } from '@/components/legal/LegalDocument'
import { LEGAL_DOCS, getLegalDoc } from '@/lib/legal/documents'

export const dynamic = 'force-static'

export function generateStaticParams() {
  return LEGAL_DOCS.map(doc => ({ slug: doc.slug }))
}

export function generateMetadata({ params }: { params: { slug: string } }): Metadata {
  const doc = getLegalDoc(params.slug)
  return { title: doc ? `${doc.title} — ScholarLens` : 'ScholarLens' }
}

export default function LegalPage({ params }: { params: { slug: string } }) {
  const doc = getLegalDoc(params.slug)
  if (!doc) notFound()

  return (
    <main className="min-h-screen bg-white text-pr-navy">
      <MarketingHeader />
      <LegalDocument doc={doc} />
      <MarketingFooter />
    </main>
  )
}
