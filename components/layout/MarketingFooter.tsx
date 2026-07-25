import Link from 'next/link'
import { LEGAL_DOCS } from '@/lib/legal/documents'

export function MarketingFooter() {
  return (
    <footer className="border-t">
      <div className="mx-auto max-w-6xl px-6 py-10 text-sm text-pr-muted">
        <div className="flex flex-wrap justify-center gap-x-5 gap-y-2 border-b border-pr-line pb-6 sm:justify-start">
          {LEGAL_DOCS.map(doc => (
            <Link key={doc.slug} href={`/legal/${doc.slug}`} className="hover:text-pr-navy">
              {doc.navLabel}
            </Link>
          ))}
        </div>
        <div className="mt-6 flex flex-col items-center justify-between gap-2 sm:flex-row">
          <span>© {new Date().getFullYear()} ScholarLens</span>
          <div className="flex gap-4">
            <Link href="/login" className="hover:text-pr-navy">Log in</Link>
            <Link href="/signup" className="hover:text-pr-navy">Sign up</Link>
            <a href="mailto:contact@scholarlens.ac" className="hover:text-pr-navy">Contact</a>
          </div>
        </div>
      </div>
    </footer>
  )
}
