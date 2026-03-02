---
argument-hint: <site-id>
allowed-tools: Bash, Read, Glob
---

Publish the site content snapshot for site "$ARGUMENTS" (default: "avocado-stories").

Steps:
1. Determine the site ID from the argument (default to "avocado-stories" if blank)
2. Hit the orchestrator publish endpoint:
   ```
   curl -X POST http://localhost:4200/publish \
     -H "Content-Type: application/json" \
     -d '{"session": "dev", "siteId": "<site-id>"}'
   ```
3. Check the response — it should contain `status`, `commitSha`, and `slugs`
4. If publish mode is git, verify the commit was created:
   - `git log --oneline -1` should show a `publish: session ...` commit
5. Report the published slugs and commit SHA
