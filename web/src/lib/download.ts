export function downloadBytes(bytes: Uint8Array, mime: string, filename: string) {
  const blob = new Blob([bytes], { type: mime })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  URL.revokeObjectURL(url)
}

// Only http(s) links are rendered as hrefs; anything else from scraped or agent data is dropped.
export function safeUrl(url: string | null | undefined): string | null {
  try {
    const u = new URL(url ?? '')
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.toString() : null
  } catch {
    return null
  }
}
