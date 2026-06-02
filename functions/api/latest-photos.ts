// GET /api/latest-photos?count=10
//
// Returns the N most recently uploaded photos, sorted by R2 upload
// timestamp descending.
//
// Response: { success, data: Photo[], meta: { count, total } }
//
// Required CF Pages config (shared with /api/random-photos):
//   - R2 binding:  name=PHOTOS_BUCKET  -> bucket=photos-webclown-net
//   - Env var:     S3_CUSTOM_DOMAIN    (e.g. https://r2.photos.webclown.net)

interface Env {
  PHOTOS_BUCKET: R2Bucket
  S3_CUSTOM_DOMAIN?: string
}

interface PhotoEntry {
  key: string
  uploaded: string // ISO 8601
}

const SITE_ORIGIN = 'https://photos.webclown.net'
const CACHE_TTL_S = 300
const MAX_COUNT = 20

const CORS_HEADERS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, OPTIONS',
  'access-control-max-age': '86400',
}

function isExcluded(key: string): boolean {
  return key.startsWith('_hidden/') || key.startsWith('.afilmory/') || key === 'logo.jpg'
}

function basename(key: string): string {
  return key.split('/').pop() ?? key
}

function successResponse(data: unknown, meta: Record<string, unknown>): Response {
  return new Response(JSON.stringify({ success: true, data, meta }), {
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      ...CORS_HEADERS,
    },
  })
}

function errorResponse(code: string, message: string, status: number): Response {
  return new Response(JSON.stringify({ success: false, error: { code, message } }), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', ...CORS_HEADERS },
  })
}

async function listSortedEntries(bucket: R2Bucket): Promise<PhotoEntry[]> {
  const entries: PhotoEntry[] = []
  let cursor: string | undefined
  do {
    const result = await bucket.list({ limit: 1000, cursor })
    for (const obj of result.objects) {
      if (!isExcluded(obj.key)) {
        entries.push({ key: obj.key, uploaded: obj.uploaded.toISOString() })
      }
    }
    cursor = result.truncated ? result.cursor : undefined
  } while (cursor)

  // Sort newest first
  entries.sort((a, b) => b.uploaded.localeCompare(a.uploaded))
  return entries
}

export const onRequestOptions: PagesFunction = () => new Response(null, { status: 204, headers: CORS_HEADERS })

export const onRequestGet: PagesFunction<Env> = async (ctx) => {
  const url = new URL(ctx.request.url)
  const rawCount = Number.parseInt(url.searchParams.get('count') ?? '10', 10)
  if (Number.isNaN(rawCount) || rawCount < 1) {
    return errorResponse('INVALID_PARAM', '`count` must be a positive integer', 400)
  }
  const count = Math.min(rawCount, MAX_COUNT)

  const cache = caches.default
  const cacheKey = new Request(`${SITE_ORIGIN}/__api_cache/photo-entries-sorted`)
  let entries: PhotoEntry[] | undefined

  const cached = await cache.match(cacheKey)
  if (cached) {
    entries = await cached.json<PhotoEntry[]>()
  }

  if (!entries) {
    entries = await listSortedEntries(ctx.env.PHOTOS_BUCKET)
    await cache.put(
      cacheKey,
      new Response(JSON.stringify(entries), {
        headers: {
          'content-type': 'application/json',
          'cache-control': `public, max-age=${CACHE_TTL_S}`,
        },
      }),
    )
  }

  const total = entries.length
  const picked = entries.slice(0, count)

  const r2Origin = (ctx.env.S3_CUSTOM_DOMAIN ?? '').replace(/\/$/, '')

  const photos = picked.map(({ key, uploaded }) => {
    const name = basename(key)
    const slug = name.replace(/\.[^.]+$/, '')
    return {
      thumbnailUrl: `${SITE_ORIGIN}/thumbnails/${name}`,
      originalUrl: r2Origin ? `${r2Origin}/${key}` : null,
      photoPageUrl: `${SITE_ORIGIN}/photos/${slug}`,
      uploadedAt: uploaded,
    }
  })

  return successResponse(photos, { count: photos.length, total })
}
