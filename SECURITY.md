# Security Policy

## Reporting a Vulnerability

If you believe you've found a security vulnerability in Avocado Studio, please report it privately using **[GitHub's private vulnerability reporting](https://github.com/avocadostudio-ai/avocado/security/advisories/new)**.

Please do **not** open a public issue, pull request, or discussion for anything you suspect may be a security issue.

When you report, it helps if you can include:

- A description of the issue and the component affected (orchestrator, editor, site, SDK, etc.).
- Reproduction steps or a minimal proof of concept.
- The impact you believe the issue has (data exposure, privilege escalation, RCE, etc.).
- Your environment (commit SHA, deployment target, Node version) if relevant.

You should receive an initial response within a few business days. We'll work with you on a fix and a coordinated disclosure timeline.

## Scope

The following are in scope:

- Code in this repository (`apps/*`, `packages/*`).
- The default orchestrator, editor, and site configurations.
- Published packages under the `@ai-site-editor/*` scope.

The following are generally out of scope:

- Issues that require a user to run a locally-modified build with disabled safety features.
- Findings in third-party dependencies that don't have a concrete exploit path through this project (please still report them — we want to know — but they'll be triaged against upstream).
- Social engineering, physical attacks, or denial-of-service through resource exhaustion of a self-hosted instance you control.

## Safe Harbor

Good-faith security research that follows this policy is welcome. We won't pursue legal action against researchers who:

- Stay within the scope above.
- Avoid privacy violations, data destruction, and service degradation.
- Give us reasonable time to investigate and fix before any public disclosure.

Thanks for helping keep the project and its users safe.
