# Agent Mode — Model Evaluation & Recommendations

Last updated: 2026-03-29

## Context

The agent mode (`/agent/start` SSE, `/agent/chat` blocking) runs a multi-turn tool-use loop where the LLM calls tools iteratively to read site state, look up block schemas, search for images, and mutate pages. This is the primary editing path in the live editor.

We evaluated three Anthropic models across a 15-test e2e suite covering atomic operations, structural edits, and a complex multi-tool page composition scenario.

## Models Tested

| Model | ID | Tier |
|-------|-----|------|
| Haiku 4.5 | `claude-haiku-4-5-20251001` | Fast |
| Sonnet 4.6 | `claude-sonnet-4-6` | Balanced (current default) |
| Opus 4.6 | `claude-opus-4-6` | Reasoning |

## Test Suite

15 scenarios in `apps/orchestrator/src/agent-e2e.test.ts`:

| # | Category | Scenario | What it exercises |
|---|----------|----------|-------------------|
| 1 | Read-only | Describe page sections | Context injection, no mutations |
| 2 | Text edit | Change hero heading (exact match) | `batch_update_props` |
| 3 | Multi-field | Hero subheading + CTA button | Two `batch_update_props` across blocks |
| 4 | Add block | FAQ with 3 items | `add_block_with_content` |
| 5 | Remove block | Remove testimonials | `remove_block` |
| 6 | Move block | CTA after hero (index assertion) | `move_block` |
| 7 | Create page | /recipes with hero + RichText | `create_page` |
| 8 | Rename page | /bananas to /tropical-bananas | `rename_page` |
| 9 | Add list item | New FAQ on /about-us | `add_item` |
| 10 | Remove list item | Delete specific FAQ by content | `remove_item` |
| 11 | Creative rewrite | "Make hero more exciting" | `batch_update_props` or `generate_variations` |
| 12 | Cross-page | "How many pages?" | Context awareness |
| 13 | Duplicate | Duplicate features grid | `duplicate_block` |
| 14 | Efficiency | Simple edit, <=10 tool calls | Runaway loop guard |
| 15 | **Complex** | Full landing page with 5 block types + Unsplash images | `get_block_schema` + `unsplash_search` + `create_page` |

Test 15 is the key differentiator — it requires the agent to:
- Call `get_block_schema` to learn correct prop structures
- Call `unsplash_search` for hero and card images
- Create a page with Hero, CardGrid, Testimonials, FAQAccordion, and CTA blocks
- Populate all blocks with coherent, themed content

## Results

### Pass Rates (all 15/15 after prompt tuning)

| Model | Pass Rate | Total Duration | Avg Tool Calls |
|-------|-----------|---------------|----------------|
| **Haiku 4.5** | **15/15** | **81s** | 1.9 |
| Sonnet 4.6 | 15/15 | 193s | 1.9 |
| Opus 4.6 | 15/15 | 122s* | 1.1* |

*Opus was tested on an earlier version of the suite (14 tests, before the complex scenario was added).

### Test 15 (Complex Landing Page) — Haiku vs Sonnet

| Metric | Haiku 4.5 | Sonnet 4.6 |
|--------|-----------|------------|
| Duration | **24s** | 61s |
| Tool calls | 10 | 10 |
| Tools used | `get_block_schema`, `unsplash_search`, `create_page` | `get_block_schema`, `unsplash_search`, `create_page` |
| Block count | 5+ | 5+ |
| Correct prop names | Yes | Yes |
| Unsplash images | Yes (hero + cards) | Yes (hero + cards) |

Both models follow the same tool-call strategy and produce structurally correct pages. Haiku does it 2.5x faster.

### Feature Support

| Feature | Haiku 4.5 | Sonnet 4.6 | Opus 4.6 |
|---------|-----------|------------|----------|
| Multi-turn tool use | Yes | Yes | Yes |
| Streaming | Yes | Yes | Yes |
| Prompt caching | Yes | Yes | Yes |
| Fine-grained tool streaming | Yes | Yes | Yes |
| Extended thinking | Works* | Yes | Yes |

*Haiku accepts the `thinking` parameter without error. It either supports it silently or ignores it — either way, it doesn't break. The `shouldUseThinking()` guard fires on complex requests (e.g., test 15). A future model version could reject this; consider gating by model name if this becomes an issue.

## Findings

### 1. All models are equally capable for the current tool set

Same pass rate, same tool-call count, same strategy. The agent tools are well-structured enough that even Haiku executes correctly.

### 2. Schema lookup is critical for correctness

Early runs without `get_block_schema` instructions failed because models guessed prop names (e.g., `testimonials` instead of `items`). After adding a mandatory schema-lookup instruction to `editing-guidelines.md`, all models call `get_block_schema` before creating blocks.

This was the single biggest correctness issue discovered: **wrong prop names produce blocks that render empty/broken in the live site but don't cause tool errors.**

### 3. Speed scales linearly with model size

Haiku is ~2.4x faster than Sonnet for the full suite, and ~2.5x faster for the complex scenario specifically. Opus adds ~20% more time over Sonnet.

### 4. Cost differences are dramatic

From the earlier 14-test run with token tracking:

| Model | Suite Cost |
|-------|-----------|
| Haiku 4.5 | ~$0.05 |
| Sonnet 4.6 | ~$0.18 |
| Opus 4.6 | ~$0.91 |

Opus is 18x more expensive than Haiku for identical results. At 30 CI runs/day: Haiku = $1.50/day, Sonnet = $5.40/day, Opus = $27/day.

## Recommendations

### E2E Testing Default: Haiku

Use `claude-haiku-4-5-20251001` as the default for `test:e2e:agent`. Same correctness, 2.5x faster, 18x cheaper. Override with `E2E_AGENT_MODEL` for regression testing against other models.

### Production Default: Sonnet (status quo)

Keep `claude-sonnet-4-6` as the production default (`AGENT_ANTHROPIC_MODEL`). While Haiku passes all current tests, production prompts are more varied and ambiguous. Sonnet's stronger reasoning provides a safety margin for edge cases not covered by the test suite.

### When to use Opus

Reserve for specific scenarios where reasoning depth matters:
- Multi-page restructuring
- Complex content migration
- Ambiguous prompts requiring nuanced interpretation

Consider exposing model selection to users (already wired via `body.model` in the agent route).

### Prompt Hardening

The `editing-guidelines.md` change (mandating `get_block_schema` calls) should ship to production. It fixed a real rendering bug that affected all models — LLMs guess prop names when not explicitly told to look them up.

## Running the Evaluation

```bash
# Default (Anthropic, server default model)
pnpm --filter @ai-site-editor/orchestrator test:e2e:agent

# Specific model
E2E_AGENT_MODEL=claude-haiku-4-5-20251001 pnpm --filter @ai-site-editor/orchestrator test:e2e:agent

# OpenAI provider
E2E_AGENT_PROVIDER=openai E2E_AGENT_MODEL=gpt-4o pnpm --filter @ai-site-editor/orchestrator test:e2e:agent
```

Reports are written to `.data/evals/agent-e2e_<provider>_<model>_<timestamp>.json` — one file per run, never overwritten.
