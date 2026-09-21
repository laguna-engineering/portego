/**
 * Response headers for an artifact preview. The document runs its own inline
 * scripts and nothing else: no application origin, no cookies, no network, no
 * navigation, no workers.
 */

/**
 * `sandbox allow-scripts` puts the document in an opaque origin. It has no
 * access to cookies, storage, or the framing page, and `allow-same-origin` is
 * deliberately absent, which is what makes the rest of this list meaningful.
 *
 * Artifacts are self-contained by definition, so every source of content is
 * either inline or a data/blob URL. `unsafe-eval` is here because bundlers
 * produce code that needs it; inside an opaque origin with no network it grants
 * a document nothing it did not already have over its own bytes.
 */
export function previewContentSecurityPolicy(appOrigin: string): string {
  return [
    "default-src 'none'",
    "script-src 'unsafe-inline' 'unsafe-eval' blob:",
    "style-src 'unsafe-inline'",
    "img-src data: blob:",
    "font-src data:",
    "media-src data: blob:",
    "connect-src 'none'",
    "frame-src 'none'",
    "child-src 'none'",
    "worker-src 'none'",
    "form-action 'none'",
    "base-uri 'none'",
    "object-src 'none'",
    `frame-ancestors ${appOrigin}`,
    "sandbox allow-scripts",
  ].join("; ");
}

const PERMISSIONS_POLICY = [
  "accelerometer=()",
  "ambient-light-sensor=()",
  "autoplay=()",
  "camera=()",
  "clipboard-read=()",
  "clipboard-write=()",
  "display-capture=()",
  "encrypted-media=()",
  "fullscreen=()",
  "geolocation=()",
  "gyroscope=()",
  "magnetometer=()",
  "microphone=()",
  "midi=()",
  "payment=()",
  "publickey-credentials-get=()",
  "screen-wake-lock=()",
  "usb=()",
  "xr-spatial-tracking=()",
].join(", ");

export function previewHeaders(appOrigin: string): Record<string, string> {
  return {
    "content-type": "text/html; charset=utf-8",
    "content-security-policy": previewContentSecurityPolicy(appOrigin),
    "permissions-policy": PERMISSIONS_POLICY,
    "referrer-policy": "no-referrer",
    "x-content-type-options": "nosniff",
    "cross-origin-resource-policy": "same-site",
    // A preview URL is a short-lived capability. Nothing should keep a copy.
    "cache-control": "private, no-store",
  };
}
