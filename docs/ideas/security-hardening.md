# Security Hardening (Deferred)

## Context

The editable site runs in a protected environment (behind auth/VPN). The production deployment is a static export with no editor routes, no draft cookies, no postMessage bridge. The editor attack surface is limited to users who already have environment access.

These items should be revisited when the editor becomes public-facing.

---

## Items

### 1. Cookie `httpOnly` + `secure` flags on draft cookies

**File:** `packages/site-sdk/src/draft-routes.ts`

Draft-enable sets cookies without `httpOnly` or `secure` flags. In a public environment:
- `httpOnly` prevents client-side JS from reading the cookie (XSS mitigation)
- `secure` ensures cookies are only sent over HTTPS

**Why deferred:** The `editorOrigin` cookie is intentionally read client-side by `EditorOverlay` to establish the postMessage bridge. Setting `httpOnly` on it would break the overlay. The draft secret cookie could be `httpOnly`, but in a protected env the risk is minimal.

**Trigger:** Editor becomes accessible without VPN/auth.

### 2. Constant-time draft secret comparison

**File:** `packages/site-sdk/src/draft-routes.ts` (or `packages/shared/src/draft-mode.ts`)

The draft secret is currently compared with `===`, which is vulnerable to timing attacks. Use `crypto.timingSafeEqual` instead.

**Why deferred:** Timing attacks require many requests with precise timing measurements. In a protected environment with network jitter, this is not practically exploitable.

**Trigger:** Editor becomes accessible without VPN/auth.

### 3. Iframe `sandbox` attribute

The editor loads the site in an iframe. Adding `sandbox` would restrict the iframe's capabilities, but `allow-same-origin` is required for the postMessage bridge and cookie access, which negates most sandbox benefits.

**Why deferred:** `sandbox` without `allow-same-origin` breaks core functionality. With `allow-same-origin`, the security benefit is marginal.

**Trigger:** If the architecture changes to cross-origin iframe communication.

### 4. Rate limiting on draft enable endpoint

The `/api/editor/draft/enable` endpoint accepts a secret parameter. Without rate limiting, an attacker could brute-force the secret.

**Why deferred:** Protected environment. Also, the secret is typically a long random string, making brute force impractical even without rate limiting.

**Trigger:** Editor becomes public-facing, or draft secret becomes shorter/predictable.

### 5. CSP headers on JSON API responses

Editor API routes return JSON, not HTML. CSP headers on JSON responses are defense-in-depth against MIME-sniffing attacks.

**Why deferred:** Modern browsers don't MIME-sniff JSON responses. The integrator controls CSP for HTML pages. Adding `X-Content-Type-Options: nosniff` to JSON responses would be a simple win but is low priority.

**Trigger:** General hardening pass before public release.
