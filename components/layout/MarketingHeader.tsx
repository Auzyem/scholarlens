'use client'

import { useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import { ChevronDown } from 'lucide-react'
import { Logo } from '@/components/layout/Logo'
import { LEGAL_DOCS } from '@/lib/legal/documents'

export function MarketingHeader() {
  const [legalOpen, setLegalOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    function onClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setLegalOpen(false)
    }
    document.addEventListener('click', onClick)
    return () => document.removeEventListener('click', onClick)
  }, [])

  return (
    <header className="sticky top-0 z-20 border-b bg-white/80 backdrop-blur">
      <div className="mx-auto flex max-w-6xl items-center justify-between px-6 py-4">
        <Link href="/">
          <Logo size={26} />
        </Link>
        <nav className="hidden items-center gap-6 text-sm text-pr-body sm:flex">
          <Link href="/#how" className="hover:text-pr-navy">How it works</Link>
          <Link href="/#features" className="hover:text-pr-navy">Features</Link>
          <Link href="/#pricing" className="hover:text-pr-navy">Pricing</Link>
          <Link href="/#contact" className="hover:text-pr-navy">Contact</Link>
          <div ref={ref} className="relative">
            <button
              onClick={() => setLegalOpen(o => !o)}
              className="inline-flex items-center gap-1 hover:text-pr-navy"
              aria-expanded={legalOpen}
            >
              Legal <ChevronDown className={`h-3.5 w-3.5 transition-transform ${legalOpen ? 'rotate-180' : ''}`} />
            </button>
            {legalOpen && (
              <div className="absolute right-0 top-full mt-3 w-64 rounded-xl border bg-white p-2 shadow-lg">
                {LEGAL_DOCS.map(doc => (
                  <Link
                    key={doc.slug}
                    href={`/legal/${doc.slug}`}
                    onClick={() => setLegalOpen(false)}
                    className="block rounded-lg px-3 py-2 text-sm text-pr-body hover:bg-pr-surface-alt hover:text-pr-navy"
                  >
                    {doc.navLabel}
                  </Link>
                ))}
              </div>
            )}
          </div>
        </nav>
        <div className="flex items-center gap-3 text-sm">
          <Link href="/login" className="text-pr-body hover:text-pr-navy">Log in</Link>
          <Link href="/signup" className="rounded-md bg-pr-teal px-3 py-1.5 font-medium text-white hover:bg-pr-teal-600">
            Sign up
          </Link>
        </div>
      </div>
    </header>
  )
}
