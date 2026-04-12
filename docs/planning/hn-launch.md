# HN Launch Plan — First Public Outing

**Status:** Draft — ready for pickup. Do not post until every checklist item is green.

This is the preparatory plan for the first public Show HN post for Avocado Studio. It contains the pre-flight checklist, the final post draft, the pre-written FAQ responses, the launch-day timeline, and post-launch followup. Open this doc on a second screen during launch day.

---

## 1. Launch overview

**Goal:** First public appearance on Hacker News. Optimize for **quality signal** (serious technical commenters, real user trials, honest feedback) over upvote count. Success looks like 3–5 deep technical comment threads, 1–2 "I tried it on my site" reports, and a sustainable wave of GitHub activity over the following week. Upvotes and front-page time are secondary.

**Audience:** Next.js developers, indie hackers, self-hosting enthusiasts, MACH-stack engineers, agencies building client sites, solo founders modernizing off WordPress.

**Positioning:** Open, self-hostable AI content editor that sits on top of your existing stack. Typed operations with plan approval. Two editing surfaces (chat + Puck). Honest scope.

**What this post is NOT:**
- Not a fundraising announcement
- Not a pricing / customers / business-model post
- Not a "we compete with Adobe AEM" framing (save that for docs, not the title)
- Not a claim of "fully open source" (orchestrator is closed binary today)

---

## 2. Pre-flight checklist

Every item must be green before posting. If any item is red, delay the launch.

### Must-haves

- [ ] **Public GitHub repo** at stable URL
  - [ ] README polished, matches post framing
  - [ ] LICENSE file at root (MIT for now on the open parts)
  - [ ] Recent commits visible (last 7 days)
  - [ ] No secrets in history (`git log -p | grep -iE "api[_-]?key|secret|token"`)
  - [ ] `.env.example` sanitized
  - [ ] "Honest scope" section in README
  - [ ] Repo one-line description matches HN title

- [ ] **Docs site deployed** to stable public URL (not localhost)
  - [ ] Index page loads fast, mobile-readable
  - [ ] `/architecture`, `/how-it-works`, `/integration/nextjs-integration` all resolve
  - [ ] Every link in the post body manually clicked and verified

- [ ] **Demo video** (2–3 min, unlisted YouTube)
  - [ ] 30-second integration walkthrough
  - [ ] One chat edit showing plan approval
  - [ ] Live preview update
  - [ ] Puck mode drag-and-drop
  - [ ] Publish flow
  - [ ] Thumbnail + link embedded in post (don't rely on auto-embed)

- [ ] **Hero screenshot: typed plan-approval UI**
  - [ ] Real chat prompt visible
  - [ ] Generated `Operation[]` with block IDs + field paths
  - [ ] "Approve" button visible
  - [ ] Hosted on stable URL (not localhost)

- [ ] **Working quickstart path**
  - [ ] Personally tested on a fresh machine / fresh directory in the last 48 hours
  - [ ] `pnpm install && pnpm dev:setup && pnpm dev:start` actually works from zero
  - [ ] No mysterious environment requirements
  - [ ] README quickstart section matches what actually works

- [ ] **Pre-written FAQ responses** (see §5 of this doc) open in a scratch buffer during launch

- [ ] **HN account ready**
  - [ ] Not brand new (has history + minimum karma)
  - [ ] Not rate-limited
  - [ ] Logged in and verified before launch day

- [ ] **Launch-day calendar blocked** — 4 hours minimum, no meetings, no other projects

- [ ] **Contact email in README** (monitored address, not a dead alias)

### Should-haves

- [ ] Traffic analytics on docs site (Plausible / Umami / similar)
- [ ] 5–10 GitHub Issues pre-seeded with known limitations / roadmap
- [ ] One pinned issue: *"HN thread feedback — drop comments here"*
- [ ] Docs page: "Compared to" (Sanity, TinaCMS, Payload, Builder, Contentful, AEM, Sitecore) — by name

### Risk management

- [ ] **Live demo decision made and documented**
  - Option A (recommended for first post): **Video only, no live demo.** Safer. Link a demo in a follow-up comment if thread is going well.
  - Option B: Link a live demo. Requires: rate limiting, docs caching, orchestrator fallback page, disabled AI for anonymous users.

- [ ] **HN front page checked the morning of launch**
  - If Anthropic / OpenAI / Google / Apple just dropped a major announcement, wait 24 hours.

- [ ] **No overlapping launches** the week of (Next.js, Vercel, Anthropic releases will steal your audience)

### Do NOT post if any of these are true

- ❌ Quickstart broken on a fresh machine
- ❌ Docs site down or behind auth
- ❌ No public GitHub repo link
- ❌ No demo video ready
- ❌ Can't commit 4 hours of attention
- ❌ Traveling / in meetings / on vacation that day
- ❌ Haven't run through FAQ responses out loud once

---

## 3. Title selection

**Primary choice (use this):**

> Show HN: Avocado Studio – open, self-hostable AI content editor for Next.js

**Alternate (if primary feels off on the morning of):**

> Show HN: AI content editor that sits on top of your existing CMS (Next.js, self-hostable)

**Rejected titles and why:**
- *"Show HN: Alternative to AEM / Sitecore"* — reads grandiose; let commenters make the comparison
- *"Show HN: The future of content operations"* — instant downvote bait
- *"Show HN: Agentic content editing with typed operations"* — too jargon-heavy, too abstract
- Anything with "revolutionary," "disruptive," "game-changing"

---

## 4. Post body (final)

Edit for your voice before posting. What's non-negotiable: the "honest scope" section and the "source not yet public" language.

---

Hi HN — first public outing for something I've been building for a while.

**Avocado Studio** is an AI content editor that plugs into an existing Next.js site. You describe edits in chat — *"add a testimonials section to /pricing"*, *"rewrite this hero in a warmer tone"* — the agent reasons about it, generates a **typed plan of operations**, and you review and approve before anything lands. Changes apply to draft first with live preview, then ship via your normal git/Vercel flow.

What makes it different from the chatbot-in-CMS-sidebar now shipping in every major DXP:

- **Composable, not a CMS.** Avocado doesn't own your content. It sits on top of Sanity, Strapi, Contentful, Notion, JSON files, or your own DB via a small Site SDK — two callbacks (`getPage`, `getSlugs`) and about 30 minutes of wiring on a vanilla Next.js 15 site.
- **Typed operations, not free-form mutations.** Every AI edit is a Zod-validated `Operation` against a typed block model. Malformed LLM output is rejected at the contract boundary. You see the diff before it applies. Undo/redo is first-class on the operation log — not bolted on.
- **Two editing surfaces, one content model.** A chat editor (natural language + plan approval) and a visual drag-and-drop editor built on [Puck](https://puckeditor.com) — both produce the same typed operations against the same blocks. Choose per-site.
- **Self-hostable.** Runs on a small VPS or any container host. Bring your own LLM keys (Anthropic / OpenAI / Gemini). Content and prompts never leave your boundary.
- **Pluggable tool runtime.** The planner can call your PIM, DAM, search index, or image generators via a typed tool contract — so *"find a hero image in our Cloudinary library"* is a real operation, not demo-ware.

**Honest scope** (please read before commenting):

- **Next.js 15 integration is rock-solid** and tested in production. Other frameworks (Astro, Nuxt, SvelteKit) are first-mover territory.
- **The Site SDK, editor app, block library, and Puck integration are MIT on GitHub.** The orchestrator is a **free Docker image** today — source not yet public, but the binary runs on your own infrastructure with no phone-home and no license key. I'm working toward a clean open-core split with an explicit license on the runtime parts. I don't want to oversell "open source" so I'm saying this up front.
- **Most battle-tested with Claude** (Haiku/Sonnet/Opus). OpenAI and Gemini work for per-edit chat. The full-site onboarding agent is Claude-only today.
- **Not a replacement for enterprise DXPs** with hundreds of editors, workflow approvals, and RBAC. Built for startups, agencies, and mid-market teams running modern composable stacks.

Why I built this: the enterprise DXPs (Adobe, Sitecore, Contentstack, Optimizely) are racing to ship agentic editing, but it's all bundled behind six-figure contracts and multi-month SI engagements. Teams who went MACH/composable precisely to avoid monolithic lock-in have no composable answer for the AI layer. This is my attempt at one.

- **Repo:** `<github-url>`
- **Docs:** `<docs-url>`
- **Demo video (3 min):** `<youtube-url>`

First time out in public, so feedback and criticism very welcome. Happy to go deep on the architecture, the typed operation pipeline, the planner→apply seam, the Puck integration, or how you'd wire it into your stack. I'll be in the thread all day.

---

## 5. Pre-written FAQ responses

Paste-and-tweak these in the thread. Don't type from scratch under pressure. Each one is ~100–200 words — short enough to stay in context, long enough to be substantive.

### FAQ 1 — "How is this different from TinaCMS / Payload / Sanity Studio / Builder.io?"

> Good question, and I want to answer it specifically because these are the closest neighbors:
>
> - **Sanity Studio** is where content lives; Avocado is the editing layer *on top of* content that can live anywhere, including Sanity via a Site SDK adapter. You can literally run Avocado against Sanity and use chat + Puck to edit it. The typed-ops-with-plan-approval layer is something Sanity Studio doesn't offer today.
> - **Payload / Directus** are full headless CMSes that own the data model. Avocado deliberately doesn't — your existing CMS stays the source of truth.
> - **TinaCMS** is the closest in spirit (git-based, typed, visual). Avocado adds the AI planning layer with typed operations and explicit plan approval, and decouples the content backend — TinaCMS is git-only; Avocado is BYO (git, Sanity, Contentful, Strapi, Notion, your own DB).
> - **Builder.io** is closest on the visual-editor side. Differentiators: self-host, BYO LLM keys, typed operation log with plan approval (Builder's AI is more generative and less reviewable).
>
> Happy to go deeper on any of these if you're using one today.

### FAQ 2 — "Why not just use Cursor / Claude Code / v0 to edit my site?"

> Different problem. Cursor and Claude Code edit *source code* — brilliant for devs, but they don't give your marketing lead a way to edit content without touching the repo. v0 generates new components from scratch — it doesn't operate on your existing site's content model.
>
> Avocado edits *content in drafts* with typed validation, plan approval, undo, and a non-technical editing surface (chat or Puck) that a content owner can actually use. The AI never writes code — it generates typed `Operation[]` against the block schemas you already have. Your developers stay in git, your content team stays in the editor, and the two don't collide.

### FAQ 3 — "What if the LLM generates garbage operations?"

> Every operation goes through a Zod schema before it touches content. If the planner outputs something malformed — wrong field type, unknown block, missing required prop — it's rejected at the contract boundary and either retried with deterministic repair feedback or surfaced to the user as a failed plan.
>
> Beyond schema validation, operations apply to a **staged copy** of the page, and the entire plan is atomic. If any op fails mid-apply, the whole plan rolls back and nothing lands in draft. And because everything is an operation log, undo/redo is first-class — even if an op you don't like lands, one click reverts it.
>
> The real risk isn't malformed ops (those we catch); it's *plausible but wrong* ops — the LLM confidently does the wrong thing within the schema. That's why nothing publishes without explicit approval. The plan shows you the typed diff before it applies, and again before it publishes. I can go deeper into the apply pipeline if you want.

### FAQ 4 — "Why isn't the orchestrator open source / why not AGPL?"

> Fair question and I want to be direct about it.
>
> The Site SDK, editor app, block library, and Puck integration are MIT on GitHub — if you run a Next.js site, everything you link against in your own repo is open source. The orchestrator is a free Docker binary today: no phone-home, no license key, self-hostable on any container host.
>
> Why not source-open the orchestrator too? I'm working toward a clean open-core split with an explicit license (likely FSL or BSL) on the orchestration parts. I didn't want to MIT-license the planner prompts and retry logic before I understood the business model, and I didn't want to go AGPL because it scares enterprise users away from the runtime parts that *should* stay permissively licensed.
>
> The honest version: I'm a solo dev building a product and trying to thread the needle between real openness and sustainable development. If "free Docker binary, runs on your own infra, no phone-home" isn't open enough for your use case, I understand — but I wanted to say it out loud rather than hide it.

### FAQ 5 — "Is this safe for production content?"

> Short answer: yes by design, but read the honest-scope section in the post for nuance.
>
> Design assumptions:
>
> - Every edit is a typed operation, not a free-form mutation
> - Operations apply to **draft** content first, never directly to published
> - The full plan shows as a typed diff before it applies
> - Publishing is a separate explicit step via your normal git/Vercel flow
> - Undo/redo is first-class on the operation log
> - If the LLM fails or generates invalid ops, the whole plan rolls back atomically
>
> Caveats:
>
> - This is early software. I test it in production on my own projects, but it isn't battle-hardened at Contentful scale.
> - Multi-user / workflow-approval / RBAC isn't there — it's a single-author tool today.
> - If your org needs formal content approval chains, that's on the roadmap but not built yet.

### Bonus responses (likely to come up)

**"Does this support [framework X]?"**

> Only Next.js 15 today. The SDK is designed to support other frameworks (the split between rendering adapters and the orchestrator contract is clean), but only Next.js is production-ready. Astro / Nuxt / SvelteKit / Remix adapters are first-mover territory — if you're interested in helping, the integration surface is documented and I'd love the collaboration.

**"What does it cost? What's the pricing?"**

> Free today — bring your own LLM keys, run it on your own infrastructure, the whole stack is self-hostable. No per-seat licenses, no minimum spend. I may eventually offer a managed hosted version for teams that don't want to run the orchestrator themselves, but there's no pricing page and no commitment today. Focus right now is getting the product and integration story right.

**"Can I hook up [obscure CMS / my own DB]?"**

> Almost certainly yes. The Site SDK is two callbacks — `getPage(slug)` and `getSlugs()` — that return typed block data. If your storage can produce that, Avocado can edit it. There are working examples in the repo for Strapi and Contentful; Sanity, Notion, Markdown files, and raw JSON all work via the same callbacks. Happy to help you wire it up — open an issue or email me.

**"How do you handle multi-language / i18n content?"**

> The editor UI itself is i18n-ready (English + German today, extensible per-locale). Content-level i18n (per-page language variants, translation workflows) isn't first-class yet — you'd handle it via your CMS's i18n model on the storage side. If you want to push on this, happy to talk through what a proper content-i18n model would look like.

---

## 6. Launch-day timeline

**T–24 hours** (day before)
- Run quickstart path from a fresh directory one more time
- Manually click every link in the post body — repo, docs, video, all internal doc pages referenced
- Check HN front page for major tech news that would eclipse the post
- Confirm demo video renders on mobile
- Reread the post out loud once
- Sleep early

**T–2 hours** (launch morning)
- Coffee. No other work.
- Check HN front page one more time
- Open this doc on a second screen
- Open the FAQ responses in a text editor, ready to paste
- Open the repo, docs, video in separate browser tabs
- Close Slack, email, all notifications

**T–0** (post live, target 9:00 AM Pacific / 12:00 PM Eastern, Tue/Wed/Thu)
- Submit the post
- Screenshot the submission for your records
- **Do not upvote your own post** (HN detects this)
- **Do not ask anyone to upvote** (also detected, also fatal)

**T+0 to T+30 min** (critical window)
- Watch the thread continuously
- Respond to every comment within 10–15 minutes
- If the top comment is hostile or wrong, respond calmly with a specific correction — don't argue, don't get defensive
- If nobody comments in the first 15 minutes, don't panic; it's normal

**T+30 min to T+2 hours** (peak visibility)
- Keep responding. The post either hits front page in this window or doesn't.
- If it hits front page: stay in the thread, answer everything
- If it doesn't: stay anyway. Tail comments matter more than rank.
- Take notes on every critical comment — these become your roadmap

**T+2 to T+4 hours** (long tail)
- Response time can relax to 30–60 minutes
- Start capturing insights for post-launch followup
- Reply to "I tried it" comments with genuine thanks and followup questions — these are your most valuable leads

**T+4 hours** (wind down)
- Last pass through new comments
- Thank people publicly in the thread
- Step away. Do not obsess for the rest of the day.

**T+24 hours**
- Final comment pass in the thread
- Pin the HN thread link in the GitHub repo README as a "join the conversation" badge
- Collect all feedback into a `hn-launch-feedback.md` followup doc
- Respond to any emails / DMs that came in

---

## 7. Post-launch followup

### Day 1 after
- [ ] Extract every technical critique from the thread into GitHub issues
- [ ] Tag the ones that are real bugs vs. roadmap items
- [ ] Reply to every email / DM that came in
- [ ] Update README with any immediate clarifications HN surfaced

### Week 1 after
- [ ] Ship 1–2 quick fixes based on HN feedback (visible activity matters)
- [ ] Write a short "what we learned from HN" post for the blog / docs (optional but builds momentum)
- [ ] Reach out personally to the 3–5 commenters who engaged most deeply — these are your first real users

### Month 1 after
- [ ] Don't post again to HN. One Show HN per product. Re-posting looks desperate.
- [ ] Convert the launch momentum into steady GitHub activity + Twitter/X presence
- [ ] Decide if/when to do a follow-up launch on a different channel (Product Hunt, Reddit, dev.to, newsletters)

### What success looks like
- 3–5 deep technical comment threads (gold)
- 1–2 "I tried it on my site" reports (platinum)
- 50–100 GitHub stars in first 48h (respectable for a niche dev tool)
- 500+ stars (a hit)
- 1000+ stars (a unicorn)
- **Real feedback > upvotes** — a silent front-page post is worse than a noisy /new post

### What failure looks like (and what to do)
- 0 comments → the title didn't land. Don't delete and repost. Learn and move on.
- Thread dominated by a single hostile critique → engage calmly, address the critique in docs within a week, let the thread die
- "This isn't actually open source" as top comment → means the honest-scope language wasn't prominent enough. Add to README, address in a thread reply, don't re-post

---

## 8. Open questions to resolve before launching

- [ ] **Live demo or video only?** Recommendation: video only for first post. Decide and document which.
- [ ] **Pricing mention in post?** Recommendation: no pricing, no business model mentioned in the body. Address only if asked in comments.
- [ ] **Which day to launch?** Recommendation: Tuesday or Wednesday. Avoid Monday and Friday.
- [ ] **Exact repo URL** — fill into §4 before posting
- [ ] **Exact docs URL** — fill into §4 before posting
- [ ] **Exact demo video URL** — fill into §4 before posting
- [ ] **HN account to use** — confirm karma / age / no recent rate limits

---

## 9. When you resume

**Start here:** run through §2 (pre-flight checklist) top to bottom. Mark each item done or blocked. Everything that's blocked is the work queue before you can post.

**Most likely blockers** (based on current repo state):
1. Demo video doesn't exist yet → record it
2. Hero screenshot doesn't exist yet → capture it
3. Docs site public URL → confirm it's deployed and permanent
4. Repo README → rewrite to match the post framing

**Do not skip the "one video + one screenshot + honest-scope language" trio.** Those are the three pieces of evidence that earn HN's trust in the first 60 seconds. Everything else is secondary.

---

## Appendix: Why this plan is shaped this way

- **The quality-over-quantity framing** comes from years of watching Show HN posts succeed and fail. The best outcomes come from 3–5 real technical commenters, not 500 vanity upvotes. Optimize accordingly.
- **The "honest scope" section in the post body** is a trust multiplier. HN rewards self-aware builders and punishes overclaimers. Saying the orchestrator is closed-binary **before** a commenter finds it is worth more than any marketing line.
- **The 4-hour commitment** isn't optional. Show HN posts where the author is absent fail almost every time. Presence is the single strongest signal of legitimacy.
- **No pricing, no fundraising, no team-size mention** — HN is ruthlessly hostile to business talk on first-post. Address only if asked, keep it short, get back to the technical discussion.
- **One Show HN per product** — you get one shot at this framing. Don't burn it with a rushed post that's missing the video.
