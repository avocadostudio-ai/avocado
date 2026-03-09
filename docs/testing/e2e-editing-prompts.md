# E2E Editing Prompt Catalog

Source: `apps/orchestrator/src/e2e-editing.test.ts`  
Scope: tests `1..27` in the task-solving suite.

## Core Suite (`e2e-editing`)

| Test | Slug | Prompt | Expected status |
| --- | --- | --- | --- |
| 1 | `/` | `Change the hero heading to 'Fresh Avocado Stories Every Day'` | `applied` |
| 2 | `/` | `Update the hero: set the subheading to 'Discover recipes, tips, and tales' and change the CTA button text to 'Start Reading'` | `applied` |
| 3 | `/` | `Add a testimonials section after the features grid with the title 'What Our Readers Say'` | `applied` |
| 4 | `/about-us` | `Add a new FAQ question: 'Do you offer a free trial?' with the answer 'Yes, all plans include a 14-day free trial'` | `applied` |
| 5 | `/` | `Remove the call-to-action section from this page` | `applied` |
| 6 | `/` | `Create a new About page at /about with a hero titled 'About Us' and a RichText block explaining our mission` | `applied` |
| 7 | `/about-lemons` | `Rename this page to /lemons and update its title to 'All About Lemons'` | `applied` |
| 8 | `/` | `Duplicate the features grid on this page` | `applied` |
| 9 | `/` | `Change the hero heading to 'Temporary Heading'` | `applied` |
| 10a | `/` | `Add a Stats section to the home page with three stats: '500+ Recipes', '50k Readers', '4.9 Rating'` | `plan_ready` (plan-only) |
| 10b | `/` | _(empty message)_ with `executionMode=apply_pending_plan` | `applied` |

## Rich Suite (`e2e-editing-rich`)

| Test | Slug | Prompt | Expected status |
| --- | --- | --- | --- |
| 11a | `/` | `Change the hero heading to 'Avocado Paradise'` | `applied` |
| 11b | `/` | `Change the CTA button text to 'Join Now'` | `applied` |
| 12 | `/` | `Change the title of the second section to 'Our Avocado Adventures'` | `applied` |
| 13 | `/strawberries` | `Remove the first question from the FAQ section` | `applied` |
| 14 | `/strawberries` | `Move the call-to-action section to the top of the page` | `applied` |
| 15 | `/bananas` | `Make the hero section more exciting and energetic` | `applied` |
| 16 | `/` | `remove the testomonials section` | `applied` |
| 17 | `/oranges` | `ad a fetures section with 3 items` | `applied` |
| 18 | `/cherries` | `put a cta at the bottom` | `applied` |
| 19 | `/olives` | `Delete this page` | `applied` |
| 20 | `/bananas` | `Duplicate /bananas to /plantains` | `applied` |
| 21 | `/about-us` | `Add a testimonials section and a CTA section to the bottom of this page` | `applied` |
| 22 | `/bananas` | `Rewrite the hero so it sounds confident and modern. Keep heading under 8 words, avoid cliches like 'unlock' or 'journey', keep CTA intact.` | `applied` |
| 23 | `/oranges` | `Refactor the existing rich-text body into exactly three concise benefit bullets, each starting with an action verb. Keep the same title and do not add new blocks.` | `applied` |
| 24 | `/` | `Rewrite both CTA labels on this page so they are consistent and action-oriented: hero CTA should invite exploring, footer CTA should invite joining. Keep all links unchanged and avoid exclamation marks.` | `applied` or `needs_clarification` |
| 25 | `/` | `Make the second section title more premium and less generic, and tighten that section's copy.` | `applied` or `needs_clarification` |
| 26a | `/cherries` | `Rewrite the hero in a crisp, expert tone for health-conscious readers.` | `applied` |
| 26b | `/cherries` | `Now update the rich text intro to match that same tone, keep it under 2 sentences.` | `applied` |
| 27 | `/about-us` | `k, pls make hero less corp-y, more human. keep CTA link same. also trim subheading by ~30%, thx` | `applied` |

## Notes

- Tests `22..27` are LM-focused behavior checks.
- Tests `24` and `25` intentionally allow either direct application or clarification due to valid model variance.
