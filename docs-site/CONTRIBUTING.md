# Contributing to AI Site Editor Docs

Thank you for your interest in improving the documentation.

For general contribution guidelines (code, tests, PRs), see the [root CONTRIBUTING.md](../CONTRIBUTING.md).

## Editing documentation

### Option 1: Edit directly on GitHub

1. Navigate to the page you want to edit in the `docs-site/` directory
2. Click the pencil icon to edit
3. Submit a pull request with your changes

### Option 2: Local development

1. Fork and clone this repository
2. Install the Mintlify CLI: `npm i -g mint`
3. Navigate to `docs-site/` and run `mint dev`
4. Preview at `http://localhost:3000`
5. Make changes and submit a pull request

## Writing guidelines

- **Use active voice**: "Run the command" not "The command should be run"
- **Address the reader directly**: Use "you" instead of "the user"
- **Keep sentences concise**: One idea per sentence
- **Lead with the goal**: Start instructions with what the reader wants to accomplish
- **Use consistent terminology**: See `AGENTS.md` for the project glossary
- **Include examples**: Show working code, env var values, and expected outputs
- **No internal URLs**: Use placeholders like `https://<your-site>.example.com` instead of real deployment URLs

## What to contribute

- Fixes for outdated instructions or broken examples
- Clearer explanations of integration steps
- Additional framework adapter guides (Remix, SvelteKit, Astro, etc.)
- Deployment guides for new platforms (AWS Amplify, Google Cloud Run, Docker, etc.)
- Troubleshooting entries based on real integration experience
