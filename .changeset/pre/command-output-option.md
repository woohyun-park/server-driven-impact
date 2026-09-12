---
'@server-driven-impact/runtime': patch
---

Replace the prerelease commandWithInvalidations method with command(context, work, { cacheContract }). Preserve the two-argument logical result, infer cache output through overloads, validate output selection before mutation, and retain committed business data and request-time scope/contract on post-commit failures.
