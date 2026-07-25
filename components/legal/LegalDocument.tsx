import { Mail, Globe } from 'lucide-react'
import type { LegalDoc } from '@/lib/legal/documents'

export function LegalDocument({ doc }: { doc: LegalDoc }) {
  return (
    <article className="mx-auto max-w-3xl px-6 py-16">
      <header className="mb-10 border-b border-pr-line pb-8">
        <h1 className="text-3xl font-bold tracking-tight text-pr-navy sm:text-4xl">{doc.title}</h1>
        {doc.effectiveDate && (
          <p className="mt-3 text-sm text-pr-muted">Effective date: {doc.effectiveDate}</p>
        )}
      </header>

      <div className="space-y-5">
        {doc.blocks.map((block, i) => {
          if (block.type === 'heading') {
            return (
              <h2 key={i} className="pt-4 text-lg font-semibold text-pr-navy">
                {block.text}
              </h2>
            )
          }
          if (block.type === 'paragraph') {
            return (
              <p key={i} className="leading-relaxed text-pr-body">
                {block.text}
              </p>
            )
          }
          if (block.type === 'list') {
            return (
              <ul key={i} className="space-y-2">
                {block.items.map(item => (
                  <li key={item} className="flex items-start gap-2.5 leading-relaxed text-pr-body">
                    <span className="mt-2.5 h-1.5 w-1.5 shrink-0 rounded-full bg-pr-teal" />
                    {item}
                  </li>
                ))}
              </ul>
            )
          }
          return (
            <div key={i} className="rounded-xl border bg-pr-surface-alt p-5">
              <div className="font-semibold text-pr-navy">{block.name}</div>
              <div className="mt-2 flex flex-col gap-1.5 text-sm text-pr-body">
                <a href={`mailto:${block.email}`} className="inline-flex items-center gap-2 hover:text-pr-teal-700">
                  <Mail className="h-3.5 w-3.5 text-pr-teal" /> {block.email}
                </a>
                <span className="inline-flex items-center gap-2">
                  <Globe className="h-3.5 w-3.5 text-pr-teal" /> {block.website}
                </span>
              </div>
            </div>
          )
        })}
      </div>
    </article>
  )
}
