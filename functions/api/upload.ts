// POST /api/upload — receive an image from iOS Shortcut, write to R2, trigger rebuild.
//
// Required CF Pages config:
//   - R2 binding:  name=PHOTOS_BUCKET  -> bucket=photos-webclown-net
//   - Env var:     UPLOAD_SECRET      (bearer token shared with the Shortcut)
//   - Env var:     DEPLOY_HOOK_URL    (CF Pages Deploy Hook URL, optional)
//
// Request:
//   Method: POST
//   Headers:
//     Authorization: Bearer <UPLOAD_SECRET>
//     X-Filename:    e.g. 2026/2026-05-15_140530.jpg   (key inside the bucket)
//     Content-Type:  image/jpeg | image/png | image/webp
//   Body: raw image bytes (multipart NOT used — simpler for Shortcuts)
//
// Response: 200 { ok, key, bytes, triggered } | 4xx { error }

interface Env {
  PHOTOS_BUCKET: R2Bucket
  UPLOAD_SECRET: string
  DEPLOY_HOOK_URL?: string
}

const FILENAME_RE = /^[\w\-./]+\.(?:jpe?g|png|webp)$/i
const MAX_BYTES = 20 * 1024 * 1024 // 20 MB

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  })
}

export const onRequestPost: PagesFunction<Env> = async (ctx) => {
  const auth = ctx.request.headers.get('authorization') || ''
  if (!ctx.env.UPLOAD_SECRET || auth !== `Bearer ${ctx.env.UPLOAD_SECRET}`) {
    return json({ error: 'unauthorized' }, 401)
  }

  let filename = (ctx.request.headers.get('x-filename') || '').trim()
  if (!filename || filename === 'auto') {
    // Auto-name when client omits — server timestamp UTC, used as a unique key.
    // Site sort order still uses EXIF DateTimeOriginal from the image itself.
    const now = new Date()
    const Y = now.getUTCFullYear()
    const pad = (n: number) => String(n).padStart(2, '0')
    const stamp = `${Y}-${pad(now.getUTCMonth() + 1)}-${pad(now.getUTCDate())}_${pad(now.getUTCHours())}${pad(now.getUTCMinutes())}${pad(now.getUTCSeconds())}`
    const rand = Math.random().toString(36).slice(2, 8)
    filename = `auto/${Y}/${stamp}_${rand}.jpg`
  } else if (!FILENAME_RE.test(filename)) {
    return json({ error: 'invalid x-filename (allowed: [A-Za-z0-9_\\-./]+\\.(jpe?g|png|webp))' }, 400)
  }
  if (filename.startsWith('_hidden/') || filename.includes('..') || filename.startsWith('/')) {
    return json({ error: 'reserved or unsafe path' }, 400)
  }

  const contentType = ctx.request.headers.get('content-type') || 'image/jpeg'
  if (!contentType.startsWith('image/')) {
    return json({ error: `expected image/* content-type, got ${contentType}` }, 400)
  }

  const body = await ctx.request.arrayBuffer()
  if (body.byteLength === 0) return json({ error: 'empty body' }, 400)
  if (body.byteLength > MAX_BYTES) {
    return json({ error: `body too large (${body.byteLength} > ${MAX_BYTES})` }, 413)
  }

  await ctx.env.PHOTOS_BUCKET.put(filename, body, {
    httpMetadata: { contentType },
  })

  let triggered = false
  if (ctx.env.DEPLOY_HOOK_URL) {
    try {
      const r = await fetch(ctx.env.DEPLOY_HOOK_URL, { method: 'POST' })
      triggered = r.ok
    } catch {
      // ignore — upload succeeded, deploy trigger is best-effort
    }
  }

  return json({ ok: true, key: filename, bytes: body.byteLength, triggered })
}
