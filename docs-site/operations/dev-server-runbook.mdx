# Dev Server Runbook

This project runs 3 local services:

- Site: `http://localhost:3000`
- Editor: `http://localhost:4100`
- Orchestrator: `http://localhost:4200`

Use the managed workflow commands from repo root.

## Start

```bash
pnpm dev:start
```

## Check Status

```bash
pnpm dev:status
```

Expected output when healthy:

- `running`
- `pid: ...`
- `log: .../.run/devctl/dev.log`

Note: `pnpm dev:status` returns exit code `1` when stopped. That is expected.

## Restart

```bash
pnpm dev:restart
```

## Stop

```bash
pnpm dev:stop
```

## Logs

```bash
pnpm dev:logs
```

## Full Health Check

```bash
curl -sS -o /dev/null -w "3000:%{http_code}\n" http://localhost:3000/
curl -sS -o /dev/null -w "4100:%{http_code}\n" http://localhost:4100/
curl -sS http://localhost:4200/health
```

Healthy responses:

- `3000:200`
- `4100:200`
- `{"ok":true}`

## Troubleshooting

1. If site/editor/orchestrator is unreachable:
   - Run `pnpm dev:status`
   - If `stopped`, run `pnpm dev:start`
2. If status says `running` but UI fails:
   - Run `pnpm dev:logs`
   - Run the curl health checks above
3. If ports are occupied by stale processes:
   - Run `pnpm dev:stop`
   - Run `pnpm dev:start`
4. Deep diagnostics:
   - Run `pnpm dev:doctor`

