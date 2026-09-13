---
name: Deno runtime compatibility
description: Runtime and lockfile compatibility considerations for imported Deno projects.
---

Imported Deno projects can fail before application code runs when the environment has an older Deno runtime than the checked-in lockfile format. Align the runtime and regenerate the lockfile with the installed runtime rather than changing the application stack.

**Why:** The workflow cannot provide useful application errors until the runtime can parse the lockfile.

**How to apply:** When a Deno workflow reports an unsupported lockfile version, check `deno --version` and the lockfile version first; preserve dependencies while bringing those formats into alignment.