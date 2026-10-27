# Control-plane snapshot

- source: /home/z/my-project
- captured: 2026-10-27T16:29:46.532Z
- branch: agent4/control-plane (snapshot semantics — force-push replaces)
- exclusions (secrets/junk): node_modules, .next, .git, upload/, .env, db/, p0-runbook/, tool-results, logs, state-snapshots
- money-node runtime state: NOT here (see fleet-runner/scripts/state-backup.ts — data/ is gitignored by design)
