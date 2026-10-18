# Estate vault — agent4 control-plane estate

- captured: 2026-10-18T15:06:06.032Z
- source: /home/z/my-project (the live autonomous network: fleet-runner + money nodes + site)
- branch: agent4/estate-vault (snapshot semantics — force-push replaces; archive tag keeps a stable ref)
- capsule: state-2026-10-18T14-56-45.tar.gz (state-backup, quiesce-gated, tear-free)

## Restore drill (the only backup that counts is one that was restored)

```bash
git clone https://github.com/roshpinacare-sys/roshpina.git && cd roshpina
git checkout agent4/estate-vault
jq -r '.files[] | "\(.sha256)  \(.path)"' VAULT-MANIFEST.json | sha256sum -c -   # integrity
tar -xzf state/state-2026-10-18T14-56-45.tar.gz -C /tmp/restored                                         # money state out
```

The capsule unpacks to roshpina data/ledger-net + data/market-net and the runner
data (jobs.jsonl, schedules.json, keys/manifest.json). Identities restore via
operator re-license (private PEMs are intentionally NOT in git — ever).
