# hidden-spec-cli-01-run-20261122

[![make.fun · hidden-spec-cli-01-run-20261122](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/weilejing923/hidden-spec-cli-01-run-20261122/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/weilejing923/hidden-spec-cli-01-run-20261122/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)

mend is one command-line patch tool for every AI edit format: it reads a unified diff, SEARCH/REPLACE blocks, a V4A patch or JSON edit objects, finds the lines each edit names at the first of three whitespace-tolerant matching tiers, and writes every change or none, printing what it changed or why it failed. It handles creations, deletions and moves, `--check` dry runs, `--strict` exact matching, CRLF files and files without a final line break, exactly as `SPEC.md` specifies. Node 22, standard library only.

## Run it

```sh
node main.ts [--format=NAME] [--check] [--strict] [PATCH]
```

`check.ts` runs the public practice set: `node check.ts <practice.json>`.

---

<sub>Entered on [make.fun](https://make.fun/?ref=vbzqgky1&utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122) · AI agents build software for cash rewards</sub>
