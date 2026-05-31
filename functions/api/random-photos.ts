// GET /api/random-photos?count=10
//
// Returns N randomly picked photos from the R2 bucket.
// Response JSON: Array<{ thumbnailUrl, originalUrl, photoPageUrl }>
//
// Required CF Pages config (already present for /api/upload):
//   - R2 binding:  name=PHOTOS_BUCKET  -> bucket=photos-webclown-net
//   - Env var:     S3_CUSTOM_DOMAIN    (e.g. https://r2.photos.webclown.net)
//
// The full key list is cached in CF Cache for 5 minutes to avoid repeated
// R2 list calls on every request.

interface Env {
  PHOTOS_BUCKET: R2Bucket
  S3_CUSTOM_DOMAIN?: string
}

const SITE_ORIGIN = 'https://photos.webclown.net'
const CACHE_TTL_S = 300 // 5 min
const MAX_COUNT = 50

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

function shuffleInPlace<T>(arr: T[]): T[] {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[arr[i], arr[j]] = [arr[j], arr[i]]
  }
  return arr
}

async function listAllKeys(bucket: R2Bucket): Promise<string[]> {
  const keys: string[] = []
  let cursor: string | undefined
  do {
    const result = await bucket.list({ limit: 1000, cursor })
    for (const obj of result.objects) {
      if (!isExcluded(obj.key)) keys.push(obj.key)
    }
    cursor = result.truncated ? result.cursor : undefined
  } while (cursor)
  return keys
}

export const onRequestOptions: PagesFunction = () => new Response(null, { status: 204, headers: CORS_HEADERS })

export const onRequestGet: PagesFunction<Env> = async (ctx) => {
  const url = new URL(ctx.request.url)
  const count = Math.min(Math.max(1, Number.parseInt(url.searchParams.get('count') ?? '10', 10) || 10), MAX_COUNT)

  // Check CF cache first
  const cache = caches.default
  const cacheKey = new Request(`${SITE_ORIGIN}/__api_cache/photo-keys`)
  let allKeys: string[] | undefined

  const cached = await cache.match(cacheKey)
  if (cached) {
    allKeys = await cached.json<string[]>()
  }

  if (!allKeys) {
    allKeys = await listAllKeys(ctx.env.PHOTOS_BUCKET)
    await cache.put(
      cacheKey,
      new Response(JSON.stringify(allKeys), {
        headers: {
          'content-type': 'application/json',
          'cache-control': `public, max-age=${CACHE_TTL_S}`,
        },
      }),
    )
  }

  shuffleInPlace(allKeys)
  const picked = allKeys.slice(0, count)

  const r2Origin = (ctx.env.S3_CUSTOM_DOMAIN ?? '').replace(/\/$/, '')

  const photos = picked.map((key) => {
    const name = basename(key)
    const slug = name.replace(/\.[^.]+$/, '')
    return {
      thumbnailUrl: `${SITE_ORIGIN}/thumbnails/${name}`,
      originalUrl: r2Origin ? `${r2Origin}/${key}` : null,
      photoPageUrl: `${SITE_ORIGIN}/photos/${slug}`,
    }
  })

  return new Response(JSON.stringify(photos), {
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      ...CORS_HEADERS,
    },
  })
}
