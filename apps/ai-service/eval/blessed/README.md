# Blessed fixture sets

Approved corrections exported per category by:

```bash
DATABASE_URL=postgres://triageai:triageai@localhost:5432/triageai \
  pnpm eval:fixtures
```

Each `<category>.json` file is a **reviewed** query → label fixture. The
classification eval (`python -m eval.run_eval`) merges these files with
`../fixtures.json`; duplicates are replaced by the blessed correction.

Only commit generated files when the underlying corrections were intentionally
blessed (review status `approved`). `manifest.json` records the export hash.
