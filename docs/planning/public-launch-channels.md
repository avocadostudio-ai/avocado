# Public Launch Channels & Brand Assets

**Status:** In progress. HN post draft is in `docs/planning/hn-launch.md`. This doc covers the surrounding channels, brand assets, and naming decisions.

---

## 1. Brand naming — finalized

| Asset | Name | URL | Status |
|---|---|---|---|
| Product | Avocado Studio | — | Established |
| Domain | avocadostudio.ai | `https://avocadostudio.ai` | Owned |
| GitHub org (current) | `avocadostudio-ai` | `github.com/avocadostudio-ai` | Created |
| GitHub org (target) | `avocado-ai` | `github.com/avocado-ai` | Name claim filed (see §2) |
| npm scope | `@avocado-studio` | `npmjs.com/org/avocado-studio` | Created (owner: yury_h) |

### Repo naming

Once the GitHub org is settled, the repo will be:

| Org | Repo URL | Notes |
|---|---|---|
| `avocadostudio-ai` (current) | `github.com/avocadostudio-ai/avocado` | No "studio" repetition, short |
| `avocado-ai` (if claimed) | `github.com/avocado-ai/studio` | Clean, short, descriptive |

### npm package names (future)

```
@avocado-studio/site-sdk
@avocado-studio/blocks
@avocado-studio/shared
@avocado-studio/preview-adapter
@avocado-studio/editor-puck
@avocado-studio/create-ai-site-editor
```

---

## 2. GitHub `avocado-ai` name claim

The `avocado-ai` GitHub account is a dormant user with zero repos, zero public activity, one star. GitHub's [username policy](https://docs.github.com/en/site-policy/other-site-policies/github-username-policy) explicitly prohibits name squatting: *"account names may not be reserved or inactively held for future use."*

### Route 1: Name squatting report (faster)

1. Go to **https://support.github.com/contact**
2. Subject: **"Inactive username claim: avocado-ai"**
3. Body:

> I'm requesting release of the username `avocado-ai`. The account has zero repositories, zero public activity, and appears to be a name reservation rather than an active account.
>
> I'm the founder of Avocado Studio (avocadostudio.ai), an open-source AI content editor. We're preparing for our first public launch and would like to use `avocado-ai` as our GitHub organization to host the project at `github.com/avocado-ai/studio`.
>
> We currently operate under `github.com/avocadostudio-ai` but `avocado-ai` is a better fit for our brand. The account in question has no visible use and appears to violate GitHub's name squatting policy.
>
> Thank you for your consideration.

### Route 2: Trademark claim (stronger, slower)

1. Go to **https://support.github.com/contact/trademark**
2. Demonstrate common-law trademark via domain `avocadostudio.ai` + product use
3. GitHub gives trademark claims more weight

### What to expect

- Response time: 1–3 weeks typically
- If released: you get an email, claim immediately
- If declined: try again after launch when you have more public presence (stars, npm packages, docs traffic)

### If/when claimed: migration

```bash
# Create new org avocado-ai, create repo avocado-ai/studio
git remote set-url origin https://github.com/avocado-ai/studio.git
git push origin --all && git push origin --tags
# Archive avocadostudio-ai with redirect README
# Update: Vercel, Render, docs links, package.json repository fields
```

---

## 3. GitHub repo migration (from yu7321/avocado)

Current remote: `https://github.com/yu7321/avocado.git`

### Steps

```bash
# Add the new remote
git remote add new-origin https://github.com/avocadostudio-ai/avocado.git

# Push all branches + tags
git push new-origin --all
git push new-origin --tags

# Switch origin
git remote remove origin
git remote rename new-origin origin
```

### Post-migration checklist

- [ ] Old repo `yu7321/avocado` archived with single-line redirect README
- [ ] `package.json` `repository` fields updated across monorepo
- [ ] Vercel git integration repointed to new repo
- [ ] Render git integration repointed to new repo
- [ ] Docs site links updated
- [ ] CONTRIBUTING.md links updated
- [ ] Any CI/CD workflows updated

---

## 4. Launch channels

### Hacker News (primary — one-shot)

Full plan in `docs/planning/hn-launch.md`. Summary:
- Show HN post, one shot, optimize for quality signal over upvotes
- Title: **"Show HN: Avocado Studio – open, self-hostable AI content editor for Next.js"**
- Pre-written FAQ responses ready for thread
- 4-hour minimum presence on launch day
- Do not re-post. One Show HN per product.

### X / Twitter (amplification + sustained presence)

**Role:** Extends the HN window. Not a launch channel itself — it amplifies HN and builds an ongoing dev-rel presence.

**Account readiness:**
- [ ] Profile says what you're building (one line)
- [ ] Recent activity (if dormant, post a few genuine dev takes in the week before launch)
- [ ] Pinned tweet will be the launch thread

**Launch day (post ~30 min AFTER HN, not before):**

1. **Tweet 1 (hook + video):** *"Been building this for a while. Avocado Studio: an open, self-hostable AI content editor that sits on top of your existing Next.js stack. Typed operations, plan approval, Puck visual editor. First public outing today."* + attach demo video
2. **Tweet 2:** Hero screenshot (typed plan approval UI)
3. **Tweet 3:** *"Show HN thread with full context:"* + HN link
4. Stop. 3–4 tweets max. No 15-tweet threads.

**Don't ask for retweets.** Tag `#nextjs #opensource #webdev`.

**Sustained content (weeks 1–4 after launch):**
- Short clips from demo video (30s each, one feature per clip)
- Screenshots of real HN comments + your responses (social proof)
- "Shipped this week based on HN feedback" updates
- Frequency: 2–3x per week minimum for the first month

### Discord (community home base)

**Role:** Where the 3–5 serious HN commenters go to stick around. HN threads die in 48 hours; Discord is where the relationship continues.

**Server structure (6 channels max — don't over-engineer):**

```
#announcements     — launch news, releases (read-only)
#general           — open discussion
#show-your-site    — users post their integrations (becomes your best marketing)
#bugs              — quick triage before GitHub issues
#feature-requests  — captures ideas without polluting GitHub issues
#contributing      — for people who want to help
```

**Rules:**
- No bots, roles, levels, or gamification. Devs hate that.
- Your presence daily for the first 2 weeks. A dead Discord with no founder kills trust faster than no Discord.
- Welcome message: one sentence about what Avocado is + links to repo, docs, HN thread

**When to mention Discord:**
- In the HN post body: **no** — don't funnel people away from the thread
- In HN comments: **yes, once, naturally** — when someone asks "where can I follow progress?"
- On X: link in bio + tweet 3–4 of launch thread
- In GitHub README: Discord badge alongside MIT badge

---

## 5. Launch sequence (combined timeline)

### Pre-launch (T–7 days to T–1 day)

- [ ] File GitHub `avocado-ai` name claim
- [ ] Migrate repo from `yu7321/avocado` to `avocadostudio-ai/avocado`
- [ ] Record demo video (2–3 min)
- [ ] Capture hero screenshot (typed plan approval UI)
- [ ] Confirm docs site deployed to stable public URL
- [ ] Set up Discord server (6 channels)
- [ ] Confirm X/Twitter account is active and profile updated
- [ ] Run full pre-flight checklist from `docs/planning/hn-launch.md` §2
- [ ] Pre-seed 5–10 GitHub Issues with known limitations / roadmap items
- [ ] Pin one GitHub issue: *"HN thread feedback — drop comments here"*

### Launch day

```
T-2:00   Coffee. Close Slack/email. Open hn-launch.md on second screen.
T-0:00   Post to HN (Tue/Wed/Thu, 9 AM Pacific)
T+0:30   Post X launch thread (3 tweets + video + HN link)
         Add HN link to Discord #announcements
T+0:30   First Discord join from HN/X — welcome them personally
T+0:00   
 to      Stay in HN thread. Respond to every comment within 15 min.
T+4:00   
T+4:00   Last HN pass. Step away.
```

### Post-launch (T+1 day to T+30 days)

- [ ] T+1: Final HN comment pass. Collect feedback into issues.
- [ ] T+1: Reply to all emails/DMs
- [ ] T+1: Pin HN thread link in README + Discord
- [ ] T+7: Ship 1–2 quick fixes from HN feedback (visible activity)
- [ ] T+7: Optional "what we learned" blog post
- [ ] T+7: Personally reach out to top 3–5 HN commenters
- [ ] T+30: Decide on next channel (Product Hunt, Reddit, dev.to, newsletters)
- [ ] T+30: Do NOT re-post to HN. One Show HN per product.

---

## 6. Channels NOT to use at launch

| Channel | Why not now |
|---|---|
| Product Hunt | Save for a separate launch ~4–6 weeks after HN. Different audience, different prep. |
| Reddit (r/nextjs, r/webdev) | High spam sensitivity. Post only after you have GitHub stars + HN thread as social proof. |
| dev.to / Hashnode | Write a technical deep-dive article after launch, not during. |
| LinkedIn | Wrong audience for a dev tool first launch. Revisit when you have enterprise case studies. |
| Paid ads | Not until you have product-market fit (~100 users). |
| Email newsletters (TLDR, Bytes, etc.) | Pitch them after HN traction, not before. HN front-page is the best pitch to newsletter editors. |

---

## 7. Names we checked (reference)

### GitHub org availability (checked 2026-04-12)

| Name | Available? |
|---|---|
| `avocado-studio` | Taken — active org in India, 1 repo |
| `avocadostudio` | Taken — empty org, no repos |
| `avocado-ai` | Taken — dormant user, zero repos (name claim candidate) |
| `avocado-edit` | Available |
| `avocadoeditor` | Available |
| `avocado-hq` | Available |
| `avocadostudio-ai` | **Created — current org** |
| `avocadostudioai` | Available |
| `avocado` | Taken — verified Dutch company, dormant since 2013 |
| `avocado-dev` | Taken — dormant since 2019 |
| `getavocado` | Taken — real org (getavocado.com) |

### npm scope

| Scope | Status |
|---|---|
| `@avocado-studio` | **Created — owned by yury_h** |
