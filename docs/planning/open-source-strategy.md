# Open Source Strategy Recommendation — Avocado Studio

## Context

The owner is weighing three launch-day licensing strategies for Avocado Studio:
1. **Fully open source** (permissive, MIT/Apache)
2. **Open-core** (runtime permissive, "brain" FSL/BSL) — the prior advisor's recommendation
3. **Source-available** (BSL everywhere)

A prior advisor recommended **open-core from day 1**. This plan is a balanced second opinion.

### Critical constraint correction

The repo has a local MIT license but **is NOT public yet**. This is decisive: there is no public trust, no external forks, no community to betray. The owner has complete optionality on launch-day license. The prior advisor's framework implicitly treated "already open" as a sunk cost; it isn't.

### Owner's stated goals (from AskUserQuestion answers)

| Dimension | Answer |
|---|---|
| Primary goal | Mix of VC-scale startup + brand/career leverage + hobby/advocacy (NOT indie-lifestyle) |
| Revenue urgency | Important but not urgent — 6–18 months of runway |
| Team state | Solo, open to co-founder |
| Biggest fear | Someone clones and outcompetes |

### Codebase evidence (from Explore agent)

- **Legally free to choose any license**: only 2 committers (owner + Claude), no CLA, no external contributors whose rights would need untangling.
- **Substantial product, not a prototype**: ~136 TS files in orchestrator, 83 test files, 20 built-in blocks, ~12K LOC in the `chat/` planner subsystem, CMS integrations for Sanity/Strapi/Contentful.
- **Planner is cleanly isolable**: `apps/orchestrator/src/chat/` is a self-contained subtree that *could* be relicensed separately later if needed.
- **Current docs already brand the product as fully open** (`docs-site/index.mdx:19`, `README.md:15`): "self-hosted, no vendor lock-in, no per-seat pricing." BSL/FSL would directly contradict that language and require a rewrite. Apache 2.0 / MIT does not.
- **No commercial/pricing docs exist yet** — clean slate to decide monetization shape.

---

## Recommendation: Launch fully open source under **Apache 2.0, with a CLA, and keep hosted cloud + eval infra in a private repo.**

This diverges from the prior advisor. The core disagreement: for *this* owner's goals and *this* product category, open-core is premature optimization against a fear that licensing doesn't actually solve.

### Why this fits the owner's profile better than open-core

**1. The goals are a distribution game, not a protection game.**
VC-scale ambition + brand/career leverage + attracting a co-founder are all scored by the same metric: adoption. GitHub stars, self-host installs, community PRs, HN/Reddit/Twitter reach. None of those are maximized under a source-available license. The playbook that works for solo-dev-to-VC transitions is: **Supabase, Cal.com, Plausible, n8n, PostHog, Resend.** All of them launched permissive-or-AGPL-open, used the adoption signal to raise funding and attract talent, and none of them got cloned to death. The advisor's framework is better suited to an already-funded team optimizing for revenue extraction than to a solo dev in an adoption-first phase.

**2. The cloning fear is real but misidentified for this product category.**
The actual competitive threats to Avocado Studio are:
- **(a)** Vercel / Netlify / Webflow / Squarespace bolting "AI editor" onto their existing platforms
- **(b)** A well-funded YC startup in the same space with faster distribution
- **(c)** Big CMSs (Sanity, Contentful, Strapi) shipping their own chat-driven editors

None of these are stopped by FSL/BSL. Category (a) and (c) already have full stacks — they'd build their own planner in a week, not touch your code. Category (b) will rebuild the planner in 2 weeks regardless of license, because in 2026 a chat planner is mostly prompt engineering and orchestration glue — neither of which licensing actually protects. **What actually protects you:**
- Operational excellence running the hosted service
- **Proprietary eval datasets and prompt-tuning pipelines** (keep these out of the public repo entirely)
- Brand, community, trust, distribution
- Integration depth with CMSs (partnership moat)

A FSL'd planner is security theater against threats that are either immune to it or don't exist in this category. Real moats live outside the license.

**3. "Important but not urgent" revenue is the exact profile where adoption-first compounds.**
With 6–18 months of runway, you can *afford* to trade month-one revenue for month-twelve optionality. Starting with BSL forces you to commit to a pricing model and customer segment before you've met the customer. That's the riskiest moment to lock in. Launch permissive, learn who actually shows up, monetize the thing *they* want (hosted cloud, enterprise features, support contracts), then revisit license if needed.

**4. Open-core signals defensiveness at launch — the worst possible moment.**
The HN/dev crowd parses "source-available for the interesting part" as "the founder is worried about you rebuilding it." That tone hurts most at launch, when you need maximum goodwill. The prior advisor's FAQ 4 draft is technically honest but rhetorically defensive — you're leading with a weakness ("here's why I'm not fully open") instead of a strength ("I'm betting distribution beats protection; the managed cloud is how I pay rent"). The second framing wins the HN thread. The first invites pile-on.

**5. Solo + open-to-cofounder is an open-source-heavy play.**
Cofounders find each other through code, not landing pages. The kind of senior engineer who'd join a chat-driven CMS startup evaluates you by reading your repo. Permissive licensing maximizes the set of engineers who can professionally justify spending serious time in your codebase. Open-core filters some of them out. Apache/MIT filters none.

### The hedge: CLA + private-from-day-1 + trademark (this is where the advisor's concerns get addressed)

The advisor is right that downside risk exists. Path A addresses it differently and more cheaply.

**Hedge 1 — Add a CLA before publishing.**
A Contributor License Agreement gives you the *option* to relicense later without needing sign-off from dozens of external contributors. This is the **single most important hedge** in the entire decision. Sentry, Plausible, and Grafana all moved to stricter licenses after starting permissive — they could do so because they had CLAs. Elasticsearch and HashiCorp paid massively more in trust damage because they didn't. Your CLA cost today, with a 2-person committer list, is essentially zero. In 12 months, with 50 external contributors, it's a political crisis. **Do it before the repo goes public.** Use [cla-assistant.io](https://cla-assistant.io) — free for public repos, 20-minute setup.

**Hedge 2 — Keep a private companion repo from day 1.**
Draw a hard line *now* about what never goes in the public repo:
- **Hosted-service infrastructure**: multi-tenant orchestration, billing, usage metering
- **Enterprise features**: SSO, SAML, audit logs, team/workspace management, RBAC
- **Eval datasets** and prompt-tuning pipeline (this is your actual differentiator)
- **Observability and telemetry backend** for your cloud
- **Customer support tooling**, internal operator dashboards

Create `avocado-cloud` (private) before launch. Make it culturally non-negotiable that code there never merges into the public repo. These are what make the managed cloud defensible, and they do more for you than any license term can.

**Hedge 3 — Trademark the name.**
File a USPTO application for "Avocado Studio" (or whichever final name). DIY cost ~$350. Registration takes 6–12 months but ™ usage is immediate. Trademark is what Redis, Grafana, Elasticsearch, and Terraform all ultimately relied on to stop bad-faith forks from using their brand. It stops competitors from selling "Avocado Studio Pro" without being you, while leaving code permissively usable.

**Hedge 4 — Write down "what's always proprietary" for yourself.**
One page, private. List exactly what stays closed: hosted cloud, enterprise features, eval infra. Revisit every 6 months. This prevents scope creep where you accidentally open-source your moat by habit.

### Apache 2.0 vs. MIT — pick Apache

Small but real upgrade over MIT for your goals:
- **Explicit patent grant** protects you and your users from patent trolls; MIT is silent on patents
- **Corporate legal departments prefer Apache** for anything an enterprise is asked to build on or ship internally — this matters for the "self-host in a Fortune 500" sales motion
- Same permissive freedoms, same "no vendor lock-in" positioning, same self-host story
- Apache is the de-facto standard for CNCF/enterprise-ready OSS; MIT reads more "solo hobby project"

If your target audience were solo-dev-heavy OSS culture, MIT. For your stated dual audience (enterprise self-host + SaaS cloud), **Apache 2.0 is the stronger signal.**

### Why NOT AGPL

AGPL is tempting — it forces SaaS redistributors to open their modifications and is a credible anti-cloud-clone shield. Rejected for this case because:
- **Google and several large enterprises ban AGPL internally** — kills a real segment of your adoption
- **CMS integration partners** (Sanity, Strapi, Contentful ecosystem contributors) will hit AGPL friction
- **Cloud hyperscalers** aren't a realistic clone threat for a chat-driven CMS (it's not Elasticsearch) — AGPL solves a problem you don't have
- Better to keep AGPL as an *upgrade path* if the cloning threat materializes

### What would change this recommendation

Flip to open-core (Path B) if any of these become true in the next 6 months:
- Revenue urgency shifts to "critical, need revenue in 3 months" → can't afford adoption-first anymore
- Concrete evidence of actual cloning happens (not hypothetical paranoia)
- A specific enterprise prospect tells you **unprompted** that they'd pay materially more if the brain were source-available
- You hire 2+ senior engineers focused on planner R&D — the marginal cost of keeping it open rises sharply

Flip to all-BSL (Path C) only if: the hosted cloud is explicitly NOT the endgame and you want to sell enterprise self-host licenses as primary revenue. That's a harder business to run solo.

---

## Alternative scenario — "I need this to pay my bills within 12 months (possibly via getting hired)"

If the runway math tightens and this has to produce income in the next 12 months — including via a full-time job offer that comes *because* of this project — does the recommendation change?

**Short answer: the license recommendation stays identical (Apache 2.0 + CLA + private cloud repo). The monetization *playbook layered on top* changes materially.**

Counterintuitive but important: **under revenue urgency, the case for fully open actually gets *stronger*, not weaker.** Here's why.

### Why urgency makes Apache 2.0 *more* right, not less

The instinct when cash gets tight is "tighten the license so I can charge." That instinct is wrong for a solo dev in 2026 for three reasons:

**1. Enterprise self-host license sales (the thing open-core enables) take 6–12 months to close the *first* deal.** They require prospecting, demos, procurement cycles, legal review, renewal churn. You don't have time for that payoff curve. Meanwhile, a restrictive license actively chokes the three revenue paths that are *faster*:

| Revenue path | Time to first $$ | Why it needs permissive licensing |
|---|---|---|
| **Consulting / integration services** | 2–6 weeks | Inbound DMs require people *using* the OSS first → permissive license maximizes users |
| **Full-time job offer** | 1–3 months | Recruiters read public repos; source-available reads as "founder guarding a business," not "engineer we want to hire" |
| **Hosted cloud subscriptions** | 3–9 months | Someone self-hosts, finds it useful, upgrades to hosted. Adoption precedes revenue |
| Enterprise BSL self-host sales | 6–12+ months | Requires a sales motion you don't have |

The first three are all *faster* than BSL sales AND all gated on adoption AND all gated on permissive licensing. The "protective" license kills your three fastest revenue paths to defend against a threat (cloning) that doesn't materialize anyway.

**2. "Getting hired thanks to this" is probably your best-odds path — and it's the one that's most damaged by open-core.**
You're a solo builder who shipped an ambitious AI-native product end-to-end. That is *exactly* the profile that AI-adjacent companies (Anthropic, OpenAI, Vercel, Linear, Retool, Braintrust, LangChain, CopilotKit, Tldraw, Sourcegraph, Supabase, Cursor, Replit, etc.) are hiring senior engineers for **right now**, at strong comp. A hot public Apache 2.0 repo on your GitHub profile is the single strongest hiring signal you can put in front of them — stronger than a resume, stronger than a Twitter following, stronger than interview performance on coding challenges. **Source-available repos read differently to technical recruiters.** They signal "founder trying to protect a business that didn't work" rather than "engineer we want on our team." The license you pick is part of the hiring funnel.

**3. Inbound consulting is the fastest cash path for a solo OSS maintainer and it's almost entirely gated on adoption.** The consulting flywheel is: someone tries the OSS → hits a custom integration need → DMs the maintainer → paid scope-of-work. That flywheel dies if the license has commercial restrictions, because the agencies and dev shops most likely to hire you for integration work won't adopt FSL/BSL for their clients. Every additional barrier to adoption directly removes future consulting leads.

### What changes under the <12-month scenario

The *license* stays the same. The *playbook* becomes multi-tracked and more aggressive:

**Month 0–1 — launch with maximum hiring surface area**
- Ship the launch under Apache 2.0 + CLA (base plan, unchanged)
- Write **two** launch posts, not one:
  - *Product post* (HN, /r/sideproject, /r/nextjs, Twitter): "Try Avocado Studio"
  - *Engineering post* (personal blog, dev.to, LinkedIn): "What I learned building an AI-native product end-to-end solo" — deep technical dive on architecture, trade-offs, planner design, streaming UX. **This is the post recruiters will read.** Cross-post to HN.
- Update LinkedIn headline to "Creator of Avocado Studio" with repo link
- Make your GitHub profile README feature the project prominently
- Enable **GitHub Sponsors** on day 1 — zero cost, small passive income, and a legitimate "support the maintainer" option that's psychologically easier for companies than a procurement cycle

**Month 0–2 — activate the consulting path in parallel**
- Publish a one-page "Avocado Studio integration services" offering aimed at agencies and Next.js dev shops who want AI editing in client sites but don't want to integrate it themselves
- Round-number pricing: $5k–$15k per integration, fixed scope
- Link from the README and docs site ("Need help integrating this? Contact me")
- **A single $10k integration contract covers 1–2 months of runway.** This is the fastest cash path.

**Month 2–4 — ship a minimum-viable hosted cloud**
- Run one orchestrator instance, one editor instance, point users at your URL
- Stripe Checkout + manual provisioning. Don't build billing infra. 10 customers max before you automate.
- Price at $20–$50/site/month
- The goal is **not** MRR optimization — it's proof that *someone* will pay for hosted. That proof is what you take to a VC conversation *or* a job interview.

**Month 3 — start the job search in parallel (do not wait)**
- Do **not** wait until month 10 when runway is gone. Interview cycles at strong AI-adjacent companies take 6–10 weeks; you want offers in hand well before runway panic.
- Target list (all hiring AI-adjacent senior/staff engineers as of early 2026): Anthropic, OpenAI, Vercel, Linear, Retool, Braintrust, LangChain/LangSmith, CopilotKit, Tldraw, Sourcegraph, Cursor, Replit, Supabase, Resend, Cal.com, Mintlify, Zed, Bolt, v0. Prioritize ones you'd actually be excited to join.
- Apply with "I built Avocado Studio" as the headline. Link the repo and the engineering blog post.
- Use the project as your technical interview substrate — every architectural decision becomes a talking point
- This is NOT giving up on the product. It's parallelizing — strong companies are fine with part-time OSS maintenance of a well-known project, and some will even pay you to keep working on it.

**Month 6 — honest checkpoint and fork the decision**

| Signal at month 6 | Action |
|---|---|
| Hosted MRR ≥ $3k/month + consulting work | Stay on product full-time. Raise a small angel round or bootstrap. The product becomes the job. |
| Hosted MRR $1–3k/month, consulting active, no job offers yet | Stretch runway. Keep shipping. Keep interviewing as a hedge. |
| Hosted MRR < $1k/month, interviews progressing | Tilt product work toward features that make the *best blog posts and demos* — ship the 1–2 things that most impress hiring managers. This isn't cynical, it's optimizing for the real goal (paying bills via a job). |
| All three weak | The license isn't the bottleneck — the market is. Accept a full-time offer, keep the repo alive as a side project, revisit in 12–18 months. |

### What changes about the hedges

Only one meaningful addition to the base plan:

**Enable GitHub Sponsors from day 1.** Costs nothing, small passive upside, and makes it frictionless for companies that want to "support open source" to send $100–$500/month your way without a procurement cycle.

Everything else — CLA, private cloud repo, trademark, "what stays proprietary" doc — stays identical. These hedges are asymmetric: near-zero cost, preserve every future option (including the "tighten the license in month 9 if I have traction but no hires" move via the CLA).

### What this scenario explicitly rules out

Under urgency, the prior advisor's **open-core-from-day-1 plan gets *worse*, not better.** High revenue urgency means:
- The enterprise BSL sales motion is too slow to pay off within the window
- The hiring-path monetization is *actively hurt* by a source-available signal
- The consulting flywheel is choked off
- Adoption (which feeds all three fast paths) is reduced

The only license move that makes sense under urgency is going *more* permissive, not less. Every extra eyeball on the repo is a potential consulting lead, hosted customer, recruiter message, or sponsor.

### Summary for the urgency scenario

**You don't monetize under pressure by protecting code. You monetize by making sure every eyeball that lands on the repo converts to *something*: adoption → consulting lead → hosted customer → job interview → sponsor. Apache 2.0 is the maximum-eyeballs license. Open-core is the minimum-eyeballs license. Pick the one whose math works under pressure — and run the monetization playbook on four parallel tracks (consulting, hosted MVP, job search, sponsors) so you're not dependent on any single one landing.**

---

## Concrete next steps (in execution order)

**Before the repo goes public:**

1. **Switch license** from MIT → Apache 2.0
   - `LICENSE` — replace with full Apache 2.0 text
   - `NOTICE` — create new file (Apache 2.0 requirement)
   - `package.json:6` → `"license": "Apache-2.0"`
   - All per-package `package.json` files with `"license": "MIT"` → `"Apache-2.0"`
   - `README.md:5` — update license badge
   - `README.md:147` — update license section
   - `docs-site/index.mdx:19` — optional: upgrade phrasing to "Apache 2.0 open source"

2. **Set up CLA** via cla-assistant.io (free for public repos)
   - Add `.github/workflows/cla.yml` or equivalent check
   - Update `CONTRIBUTING.md` to reference CLA + Apache grant language

3. **Create `avocado-cloud` private repo** (name TBD)
   - Seed it with: enterprise feature scaffolding, eval dataset stubs, observability backend stubs, billing integration stubs
   - Document internally: "code here never merges to the public repo"

4. **File USPTO trademark application** for "Avocado Studio" (~$350, DIY via [uspto.gov](https://www.uspto.gov/trademarks))

5. **Write a private one-pager**: "What stays proprietary" — hosted cloud, enterprise features, eval infra. Commit to it.

**Launch day:**

6. **HN post framing** — lead with the open bet, not a defensive FAQ. Suggested tone:
   > *"I'm solo and I want this to grow faster than I could grow it alone. It's Apache 2.0 — self-host it, fork it, build a commercial product on top if you want. I'm betting distribution beats protection, and the managed cloud is how I'll pay rent. The thing I'd ask: if this is useful to you, tell me what you'd pay for, because I'm going to optimize the cloud around exactly that."*
   This is a stronger HN framing than "here's why I'm source-available for the interesting part."

**6-month checkpoint (revisit license decision):**

7. Collect adoption data. Decide whether to stay permissive (default), move the brain to BSL using the CLA option (if real clone threat materialized), or upgrade runtime to AGPL (if hyperscaler clone threat emerges).

---

## Verification — how to know this is working

**3-month checkpoint:**
- ≥500 GitHub stars
- ≥10 issues or PRs from people who aren't you
- ≥3 unsolicited "I'm using this in production / for a client" mentions outside HN launch week

**6-month checkpoint:**
- ≥1 serious managed-cloud conversation with a real prospect willing to pay, OR
- ≥1 serious co-founder conversation that came through the repo
- If both are zero: adoption isn't converting into anything valuable — reassess monetization path (possibly flip to Path B)

**12-month checkpoint:**
- Clear answer on whether the managed-cloud offering has product-market fit
- If yes: stay fully open, scale the cloud, revisit fundraising
- If no: that's when the Path B decision becomes genuinely live — and you'll be vastly better informed than today

---

## Critical files to touch (when you execute this plan)

| File | Change |
|---|---|
| `LICENSE` | Replace MIT with Apache 2.0 full text |
| `NOTICE` (new) | Create — Apache 2.0 requires it |
| `package.json:6` | `"license": "Apache-2.0"` |
| `apps/*/package.json`, `packages/*/package.json` | Update all `"license"` fields to `"Apache-2.0"` |
| `README.md:5` | Update license badge (shields.io Apache-2.0) |
| `README.md:147` | Update "License" section |
| `docs-site/index.mdx:19` | Optional: "Apache 2.0 open source" |
| `CONTRIBUTING.md` | Add CLA link + Apache 2.0 contributor grant language |
| `docs-site/CONTRIBUTING.md` | Same updates as root CONTRIBUTING.md |
| `.github/workflows/cla.yml` (new) | cla-assistant integration |

## Stress test — steelmanning the open-core case

I'm arguing against my own recommendation here. The goal is honesty: if any of these counterarguments are strong enough to flip the answer, I'll say so. If not, I'll say that too — and be specific about where my conviction weakened.

### Counterargument 1: The mid-tier clone threat is real and specific (PARTIALLY SUCCEEDS)

I dismissed cloning risk by pointing at big players (Vercel/Webflow) who'd build their own stack, and well-funded startups who'd rebuild regardless. That covers the extremes but misses the **actual, most likely clone scenario**:

**A small team (2–5 devs) at an agency or niche SaaS company forks the repo, strips the branding, integrates the planner into their existing product, and ships it as their own feature.** They don't rebuild 12K LOC of streaming pipeline, operation validation, rollback logic, and intent routing. They just... use yours. MIT/Apache lets them do this with zero obligation — no contribution back, no payment, no acknowledgment.

This isn't hypothetical. It's the standard story for dozens of successful MIT-licensed projects whose maintainers got nothing while companies profited. FSL/BSL would mean that agency either: (a) contributes back (community win), (b) buys a commercial license (revenue win), or (c) waits 2 years for the FSL→Apache conversion (time moat). All three outcomes are better for you than "they use it for free."

**My original framing undersold this.** I called the planner "mostly prompt engineering and orchestration glue," but the codebase shows ~12K LOC of non-trivial systems work: streaming apply pipeline, incremental plan parsing, multi-provider abstraction with head-start routing, deferred image resolution, progressive op-applied events, rollback-on-failure. That's hundreds of hours of engineering. Apache 2.0 lets someone take all of it for free.

**Verdict: This counterargument partially succeeds.** The mid-tier clone threat is real and Apache 2.0 offers zero protection against it. FSL/BSL would help here. However: this threat only materializes *after* the project has enough adoption to be worth cloning. In the first 6–12 months, nobody is cloning a project with <1K stars. The CLA preserves the option to add this protection when the threat becomes real.

### Counterargument 2: Survivorship bias — the permissive-license success stories all raised VC (PARTIALLY SUCCEEDS)

I cited Supabase, Cal.com, Plausible, n8n, PostHog, Resend as proof that permissive licensing works. But:

- **Supabase raised $116M.** PostHog raised $45M. Cal.com raised $32M. They monetized through VC capital, not through organic adoption-to-revenue conversion. If you don't raise, their playbook doesn't apply.
- **For every Supabase, there are 100+ MIT-licensed projects with thousands of stars and zero revenue.** The OSS graveyard is full of popular permissive-license projects whose maintainers burned out because they couldn't monetize.
- **The two best comparisons for a solo bootstrapper are n8n and Plausible — and both use more restrictive licenses than what I recommended.** n8n uses a **Sustainable Use License** (source-available, not permissive). Plausible uses **AGPL** (copyleft, not permissive). Both are bootstrapped, profitable, solo-or-small-team businesses. They're the actual role models for your situation, and they chose *against* permissive licensing.

**Verdict: This counterargument partially succeeds.** My comparisons were biased toward VC-funded outcomes. The bootstrapped-and-profitable comparisons (n8n, Plausible) actually support the advisor's position more than mine. The main gap: n8n and Plausible both had significant traction before choosing their restrictive licenses — they had the data to know what to protect. You don't yet.

### Counterargument 3: "Source-available hurts hiring signal" is unproven and probably wrong (SUCCEEDS)

I asserted that recruiters read source-available repos differently from Apache repos, calling it a "red flag." On reflection, that claim is too strong:

- **Sentry is BSL. GitLab is partly proprietary. Elastic is SSPL. All three hire aggressively and are seen as top-tier engineering orgs.** Their license choices didn't hurt hiring.
- Technical recruiters at Anthropic, Vercel, or Cursor aren't checking your `LICENSE` file. They're reading your code quality, your commit messages, your architecture decisions. A streaming AI planner with 12K LOC of clean systems work is impressive regardless of license.
- "Source-available reads as founder-guarding-a-business" is my projection, not a data-backed observation.

**Verdict: I overstated this claim. I'm walking it back.** The hiring path works under either license. The real hiring signal is code quality and architectural ambition, not the license file.

### Counterargument 4: FSL/BSL doesn't actually hurt adoption as much as I claimed (PARTIALLY SUCCEEDS)

I framed FSL/BSL as "hostile to adoption." But the advisor's proposal is specifically FSL for the *brain only* — runtime (editor, site SDK, blocks, preview adapter) stays Apache 2.0. What does FSL on the brain actually block?

- **An individual developer self-hosting for their own sites?** Unaffected. FSL allows non-competitive use.
- **An agency using it for client projects?** Unaffected, as long as they're not *reselling the planner itself*.
- **A CMS like Sanity adding it as a feature of their commercial product?** Blocked — but this is exactly the threat you want to block.

The adoption segment that FSL actually filters out is narrow: specifically, companies that want to embed and *resell* the planner commercially. Everyone else — hobbyists, agencies, startups building on top, enterprises self-hosting — is unaffected.

Additionally: the FSL 2-year conversion clause means all code eventually becomes Apache 2.0 anyway. The worst case for a patient user is: wait 2 years. That's a much softer restriction than traditional proprietary software and is compatible with "no vendor lock-in."

**Verdict: My "adoption hit" argument was overstated.** The FSL-on-brain-only approach is more targeted than I presented. The actual adoption reduction from FSL is narrower than "everyone who would have used it" — it's closer to "companies who specifically want to resell the planner."

### Counterargument 5: A CLA signals future relicensing intent, which poisons the well (DRAW)

My plan says "add a CLA to preserve optionality." But sophisticated OSS contributors *know* what CLAs signal. A CLA + Apache 2.0 is widely read as: "We're permissive until we have enough adoption to switch, then we'll go BSL." This reading is so common it's practically a meme on HN.

Starting FSL/BSL from day 1 is at least *transparent* about intent. No one can accuse you of bait-and-switch because you never switched. The expectation is set correctly from launch.

**Verdict: This is a draw.** CLA friction is real but small. The transparency argument is genuine but the set of people who care deeply about CLAs is tiny relative to total potential users. Neither approach is cleanly better.

### Counterargument 6: "Consulting is the fastest revenue path" assumes there's demand for consulting (MINOR WEAKNESS)

The urgency scenario relies on consulting as the fastest revenue path. But the product already ships with a Site SDK, 4 CMS integration examples, and a quick-start guide. If the docs are good enough to self-serve, there's less consulting demand.

**Verdict: Minor weakness.** Consulting demand exists even with good docs (complex custom integrations, enterprise-specific requirements, etc.), but it's less reliable than I presented.

---

### Honest assessment: where do I end up after stress-testing?

**The recommendation survives, but with narrower margins than initially presented.** Here's what shifted:

| Claim in my original recommendation | After stress test |
|---|---|
| "Cloning fear is misidentified" | **Partially wrong.** The mid-tier agency-fork threat is real and specific. Apache 2.0 offers zero protection against it. |
| "Adoption-first playbook works for solo devs" | **Weakened by survivorship bias.** The bootstrapped comparisons (n8n, Plausible) chose restrictive licenses. |
| "Source-available hurts hiring signal" | **Overstated.** Walking this back. License doesn't affect hiring signal. |
| "FSL/BSL kills adoption" | **Overstated.** FSL-on-brain-only is more targeted than I presented. |
| "CLA is a clean hedge" | **Mostly true but not free.** CLA signals relicense intent to sophisticated contributors. |

**My revised conviction level: ~60/40 in favor of Apache 2.0 over FSL-on-brain, down from ~85/15.**

The 60% case for Apache: You don't have adoption data yet. Clone threats only materialize after you prove the market. The CLA preserves the option to tighten later. And the urgency scenario's multi-track playbook (consulting + cloud + hiring + sponsors) is genuinely gated on maximum adoption.

The 40% case for the advisor's FSL-on-brain: The mid-tier clone threat is real. The adoption hit from FSL is narrower than I claimed. n8n's Sustainable Use License is the closest comp and it works. And starting FSL is more transparent about intent than "Apache + CLA and we might switch."

### What should you do with this?

**If you're the kind of person who'd rather optimize for *not regretting* the decision (loss-averse):** Go with the advisor's FSL-on-brain approach. The regret from "I went permissive and got cloned" is larger and more concrete than the regret from "I went FSL and lost 15% adoption."

**If you're the kind of person who'd rather maximize expected value (risk-tolerant):** Go with Apache 2.0 + CLA. The expected-value calculation favors adoption maximization, even accounting for clone risk, because clone risk is a low-probability-high-regret event and adoption is a high-probability-moderate-payoff outcome.

**Either way, the CLA and private cloud repo are non-negotiable.** Both options need them. Do those first regardless of which license you pick.

---

## Summary: the one-line version

**You're pre-public and solo with runway, so license friction is more expensive to you than clone risk. Launch Apache 2.0, add a CLA for relicense optionality, keep cloud+evals in a private repo, and trademark the name. That gives you the upside of the advisor's open-core plan with none of the launch-day downside, and a clean escape hatch if the cloning fear turns out to be real in 12 months.**
