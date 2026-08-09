# Legal Packs

Canonical importer documentation is in:

- `<repo-root>/docs/LEGAL_PACKS_IMPORT.md`

This file exists to match the external pack contract naming (`LEGAL_PACKS.md`) used in
`Artifacts-Legal-Packs`.

For operator run commands and idempotency details, use:

```bash
node scripts/import-legal-pack.ts \
  --repo StarlinkOracle/Artifacts-Legal-Packs \
  --tag CO-v1.0.0 \
  --pack packs/CO/v1
```
