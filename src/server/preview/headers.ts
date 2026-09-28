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
 * Every source of content is inline or a data/blob URL, except the version's
 * own images. `imagesBase` is the images/ path under this preview's token, so
 * the document can load those images and nothing else from the network.
 * `unsafe-eval` is here because bundlers produce code that needs it; inside an
 * opaque origin with no network it grants a document nothing it did not
 * already have over its own bytes.
 */
export function previewContentSecurityPolicy(appOrigin: string, imagesBase: string): string {
  return [
    "default-src 'none'",
    "script-src 'unsafe-inline' 'unsafe-eval' blob:",
    "style-src 'unsafe-inline'",
    `img-src data: blob: ${imagesBase}`,
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

export function previewHeaders(appOrigin: string, imagesBase: string): Record<string, string> {
  return {
    "content-type": "text/html; charset=utf-8",
    "content-security-policy": previewContentSecurityPolicy(appOrigin, imagesBase),
    "permissions-policy": PERMISSIONS_POLICY,
    "referrer-policy": "no-referrer",
    "x-content-type-options": "nosniff",
    "cross-origin-resource-policy": "same-site",
    // A preview URL is a short-lived capability. Nothing should keep a copy.
    "cache-control": "private, no-store",
  };
}

/**
 * Headers for one of a preview's images. The type was detected from the bytes
 * at upload. If the URL is opened on its own, the sandbox and empty policy
 * keep whatever the bytes are from running.
 */
export function previewImageHeaders(contentType: string): Record<string, string> {
  return {
    "content-type": contentType,
    "content-security-policy": "default-src 'none'; sandbox",
    "referrer-policy": "no-referrer",
    "x-content-type-options": "nosniff",
    // The preview document has an opaque origin, which is not same-site with
    // anything, so same-site would block its own images. The token in the URL
    // is what grants access.
    "cross-origin-resource-policy": "cross-origin",
    "cache-control": "private, no-store",
  };
}
