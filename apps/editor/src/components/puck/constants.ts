export const FALLBACK_SESSION = "dev"
export const FALLBACK_SLUG = "/"

export const PUCK_PREVIEW_CSS = `
html, body {
  margin: 0 !important;
  padding: 0 !important;
  height: 100% !important;
  min-height: 100% !important;
  overflow: hidden !important;
}
#frame-root,
[data-puck-entry],
body > div:first-child {
  height: 100% !important;
  min-height: 100% !important;
  overflow-y: auto !important;
  overflow-x: hidden !important;
  overscroll-behavior: contain !important;
  -webkit-overflow-scrolling: touch !important;
}
/* Default theme — blocks CSS uses these variables but the editor doesn't define them.
   In the real site, globals.css provides these. In Puck's iframe, we inject defaults. */
:root {
  --bg-0: #ffffff;
  --bg-100: #f8f9fa;
  --bg-1: #ffffff;
  --section-bg: var(--bg-100);
  --text-100: #1a1a2e;
  --text-200: #4a4a6a;
  --text-300: #52525b;
  --heading: #1a1a2e;
  --body: #333355;
  --body-secondary: #6b7280;
  --caption: #64748b;
  --brand: #24613b;
  --brand-hover: #1b4d2e;
  --brand-subtle: #d4edda;
  --brand-fg: #ffffff;
  --surface: #ffffff;
  --surface-border: #e5e7eb;
  --border: #e5e7eb;
  --card-bg: #f8fafc;
  --card-shadow: 0 1px 3px rgba(0,0,0,0.08);
  --hero-bg: var(--bg-0);
  --cta-bg: var(--bg-100);
  --placeholder-img: #e2e8f0;
  --footer-bg: #1a1a2e;
  --footer-text: #cbd5e1;
  --footer-heading: #f1f5f9;
  --footer-link: #94a3b8;
  --footer-link-hover: #e2e8f0;
  --footer-border: #2d2d4a;
  --font-body: system-ui, -apple-system, sans-serif;
  --font-heading: system-ui, -apple-system, sans-serif;
  --radius-btn: 6px;
  --radius-card: 8px;
  --radius-feature: 8px;
}
`
