---
name: FFmpeg subprocess environment
description: Deno subprocesses can fail under the workflow's injected dynamic-loader environment.
---

When spawning FFmpeg from Deno in this workspace, use a clean child environment and preserve only the executable search path; inheriting the workflow's loader variables can make Deno reject the spawn.

**Why:** The Replit workflow may inject `LD_AUDIT`, and Deno refuses to spawn a child process with that loader setting even when the run permission is present.

**How to apply:** For media conversion subprocesses, set `clearEnv: true` and provide a valid `PATH`; keep the failure visible rather than silently returning an unconverted file.