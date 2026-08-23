# Project Tools

Executable scripts registered as capabilities. Register with:

```bash
infinity-harness capability add tool <file> --run "<command>" \
  --tags db,reset --description "Reset local db to fixtures"
```

Registered tools surface automatically in `the infinity_brief tool` briefs when a
task matches their tags. Standards (see `harness/skills/building-tools.md`):
idempotent · `--help` works · `--json` where output is consumed ·
exit codes 0/1/2 · never prompts interactively.
