import { buildMenuManifest } from '../src/features/online/menuManifest.js'

export function GET(request: Request): Response {
  const url = new URL(request.url)
  const manifest = buildMenuManifest(url.searchParams)

  if (!manifest) {
    return new Response(JSON.stringify({ error: 'invalid_location' }), {
      status: 400,
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
      },
    })
  }

  return new Response(JSON.stringify(manifest), {
    headers: {
      'Content-Type': 'application/manifest+json; charset=utf-8',
      'Cache-Control': 'public, max-age=300, s-maxage=3600',
      'X-Content-Type-Options': 'nosniff',
    },
  })
}
