---
name: i18n
description: Editor UI internationalization reference — custom locale provider, AI response localization, adding new languages. Use when adding translations, new locales, or wiring locale through to LLM prompts.
---

# Internationalization (i18n)

The editor UI supports multiple languages. English is the default; German is the first additional locale.

## How it works

1. **Editor UI** — Custom `LocaleProvider` + `useT()` hook in `apps/editor/src/i18n/`. No external library. Locale stored in `localStorage("editor-locale")`.
2. **AI responses** — Editor sends `locale` on every `/chat` and `/chat/start` request. The orchestrator injects a language instruction into LLM system prompts so `summary_for_user`, `change_log`, and `suggested_next_actions` come back in the user's language.
3. **Language switcher** — Settings (gear icon) → Language dropdown (English / Deutsch).

## Key files

| Layer | Files |
|-------|-------|
| Dictionaries | `apps/editor/src/i18n/en.ts` (source of truth), `apps/editor/src/i18n/de.ts` |
| Provider & hook | `apps/editor/src/i18n/index.tsx` — `LocaleProvider`, `useT()`, `getT()` |
| Orchestrator | `apps/orchestrator/src/chat/prompts.ts` — `localeInstruction()` injected into all prompt builders |
| Request type | `apps/orchestrator/src/nlp/intent-detection.ts` — `locale` field on `ChatRequestBody` |

## Adding a new language

1. Create `apps/editor/src/i18n/{code}.ts` (e.g. `fr.ts`) typed as `Record<LocaleKeys, string>` — TypeScript enforces all keys are present.
2. Import and register in `apps/editor/src/i18n/index.tsx`: add to `LOCALES` map and `LOCALE_LABELS`.
3. Extend the `Locale` type union: `export type Locale = "en" | "de" | "fr"`.
4. Add the language name to `LOCALE_NAMES` in `apps/orchestrator/src/chat/prompts.ts` so the LLM knows which language to respond in.
5. Run `pnpm typecheck` — any missing translation keys will be compile errors.

## Using translations in code

```tsx
// In React components:
import { useT } from "@/i18n"
const { t } = useT()
<h1>{t("header.publish")}</h1>
<p>{t("welcome.greeting", { name: "My Site" })}</p>  // {{name}} interpolation

// In pure functions (non-React), pass t as parameter:
function myHelper(t: TFunction) { return t("some.key") }
```

## What is NOT translated
- Block type names (Hero, CTA, FAQAccordion) — code identifiers
- Model/provider names (gpt-4o, Claude, OpenAI) — vendor-specific brand names
- Field AI suggestion pills — sent as prompts to the LLM, must stay in English
- Preview adapter overlay labels — deferred (separate package, needs postMessage protocol)
