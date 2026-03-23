# Local Prompt Stability Sweep (Anthropic, No CI)

Use this workflow to detect flaky ops-intent prompts locally before changing routing/prompt logic.

## Canonical command

```bash
pnpm -C apps/orchestrator benchmark:ops:stability:anthropic
```

This runs:

- provider: `anthropic`
- eval mode: `ops-json`
- cardinality: `single`
- prompt set: `apps/orchestrator/src/scripts/test-sets/prompt-examples.json`
- runs: `20`
- variants per prompt: `3`
- pass threshold: `90%`
- grouping: base prompt id (`foo`, `foo__v2`, `foo__v3` grouped as `foo`)
- output: `.data/evals/ops-stability-anthropic.json`

## Stability controls

The harness supports:

- `--min-pass-rate` (default `0.9`)
- `--fail-on-threshold` (default `true`)
- `--group-variants-by-base-id` (default `true`)

If `fail-on-threshold=true`, command exits non-zero when any prompt group is below threshold.

## Triage output

The console prints severity-ordered rows:

- `critical`: pass rate `< 70%`
- `high`: pass rate `>= 70%` and `< min-pass-rate`
- `flaky`: pass rate `>= min-pass-rate` with high disagreement in predictions

For `critical` and `high`, the tool prints:

- expected op(s)
- top wrong op labels (missing/unexpected)
- representative bad output preview

## JSON report

`stabilityReport` is emitted in the benchmark JSON output with:

- `thresholds` and `controls`
- aggregate `summary` (`severityCounts`, prompt groups below threshold)
- per-group metrics (`runs`, `exactMatchRate`, `avgF1`, `passRate`, `topWrongOps`, `failureKinds`)

## Fix loop

For each `critical`/`high` prompt group:

1. Update prompt instructions and/or deterministic routing/normalization.
2. Add/refine the corresponding case in `prompt-examples.json`.
3. Re-run the stability sweep until all groups meet threshold.
4. If failure is deterministic-parser logic, add direct parser unit tests (not live-LLM tests).

