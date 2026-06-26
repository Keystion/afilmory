// 缩略图防盗链：仅 /thumbnails/* 生效。
// 背景：photos.webclown.net 是 Cloudflare Pages 自定义域，不走 zone 级 WAF 自定义规则，
// 故原图（r2.photos.webclown.net，R2 域）由 WAF 防盗链，而缩略图只能在应用层校验 Referer。
// 策略：空 Referer（直接访问 / RSS / OG 抓取）放行；仅放行 webclown.net 及其子域；其余拦截。

const ALLOWED_HOST = 'webclown.net'
const ALLOWED_SUFFIX = '.webclown.net'

const refererAllowed = (referer: string | null) => {
  if (!referer) return true // 空 Referer：直接打开 / RSS / 社交卡片抓取 → 放行
  let host: string
  try {
    host = new URL(referer).hostname.toLowerCase()
  } catch {
    return false // 畸形 Referer → 拦
  }
  return host === ALLOWED_HOST || host.endsWith(ALLOWED_SUFFIX)
}

export async function onRequest(context: { request: Request; next: () => Promise<Response> }) {
  if (!refererAllowed(context.request.headers.get('Referer'))) {
    return new Response('Forbidden', { status: 403 })
  }
  return context.next()
}
