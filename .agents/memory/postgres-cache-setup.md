---
name: PostgreSQL cache setup
description: The persistent audio cache expects a reachable PostgreSQL service and its schema applied before cache writes can succeed.
---

The audio cache uses `DATABASE_URL`. Local preview startup provisions the workspace PostgreSQL service and applies the cache schema; separately managed production databases still need the schema applied through their normal release flow.

**Why:** The imported workspace can have a `DATABASE_URL` that points to localhost without a PostgreSQL listener, while startup-time DDL remains unsafe for deployed databases.

**How to apply:** For local preview, use the workflow startup script. For production, apply `scripts/audio-cache.sql` through the database's supported schema-release flow, then confirm cache read/write logs.