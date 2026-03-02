---
allowed-tools: Bash
---

Ship the current branch: commit, merge to main, and push.

Steps:
1. Run `git status` to see what needs committing
2. If there are uncommitted changes:
   - Stage all changed/new files (be selective — skip .env, credentials, large binaries)
   - Create a commit with a descriptive message and `Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>`
3. Run `git log --oneline main..HEAD` to confirm commits to ship
4. Checkout main: `git checkout main`
5. Pull latest: `git pull --ff-only`
6. Merge the working branch: `git merge --ff-only <branch>` (abort if not fast-forward)
7. Push: `git push`
8. Switch back to the working branch: `git checkout <branch>`
9. Report success with the commits that were shipped
