import { createServerClient } from '@supabase/ssr'
import { NextResponse, type NextRequest } from 'next/server'

export async function middleware(request: NextRequest) {
  let supabaseResponse = NextResponse.next({ request })

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() { return request.cookies.getAll() },
        setAll(cookiesToSet) {
          cookiesToSet.forEach(({ name, value }) => request.cookies.set(name, value))
          supabaseResponse = NextResponse.next({ request })
          cookiesToSet.forEach(({ name, value, options }) =>
            supabaseResponse.cookies.set(name, value, options))
        },
      },
    }
  )

  const { data: { user } } = await supabase.auth.getUser()

  const pathname = request.nextUrl.pathname

  // Prefix-matched public trees. '/' is deliberately NOT in this list: every
  // pathname starts with '/', so including it made `isPublic` unconditionally
  // true and the redirect below unreachable — the guard silently protected
  // nothing. The marketing root is matched exactly instead.
  const publicPrefixes = ['/login', '/signup', '/api', '/auth', '/legal']
  const isPublic = pathname === '/' || publicPrefixes.some(p => pathname.startsWith(p))
  const isAuthPage = pathname === '/login' || pathname === '/signup'

  if (!user && !isPublic) {
    return NextResponse.redirect(new URL('/login', request.url))
  }

  // Logged-in users have no business on the login/signup pages.
  if (user && isAuthPage) {
    return NextResponse.redirect(new URL('/dashboard', request.url))
  }

  return supabaseResponse
}

export const config = {
  // Also skips any path with a file extension (`/icon.png`, `/robots.txt`, …).
  // Those are public assets, and now that the auth redirect above actually
  // fires, a logged-out visitor requesting one would otherwise be bounced to
  // /login and the asset would fail to load on the marketing page.
  matcher: ['/((?!_next/static|_next/image|favicon.ico|.*\\..*).*)'],
}
