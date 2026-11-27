// Security headers shared by the Electron app:// handler and the Vite dev server.

/**
 * Same-origin isolation (COOP, COEP, CORP) as hardening of the window's own origin: other origins cannot embed its
 * resources or share its browsing context group. Nothing in the program depends on it.
 */
export const isolationHeaders = {
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Embedder-Policy": "require-corp",
  "Cross-Origin-Resource-Policy": "same-origin",
} as const;

/** Strict policy for built bundles: own origin only, no WebAssembly, no workers, no inline scripts or styles. */
export const contentSecurityPolicy = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data: blob:",
  "font-src 'self'",
  "worker-src 'none'",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "frame-ancestors 'none'",
  "form-action 'none'",
].join("; ");

export const responseHeaders = {
  ...isolationHeaders,
  "Content-Security-Policy": contentSecurityPolicy,
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=(), usb=(), serial=(), hid=(), bluetooth=()",
} as const;
