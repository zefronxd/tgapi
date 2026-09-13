#!/usr/bin/env bash
set -euo pipefail

PGDATA="${PGDATA:-/tmp/zefron-pgdata}"
PGPORT="${LOCAL_PGPORT:-5432}"
PGHOST="${LOCAL_PGHOST:-127.0.0.1}"
PGUSER="${LOCAL_PGUSER:-zefron_user}"
PGDATABASE="${LOCAL_PGDATABASE:-zefron_db}"
PGLOG="${PGLOG:-/tmp/zefron-postgres.log}"

if ! pg_ctl -D "$PGDATA" status >/dev/null 2>&1; then
  if [ ! -f "$PGDATA/PG_VERSION" ]; then
    initdb -D "$PGDATA" -U "$PGUSER" --auth-local=trust --auth-host=trust >/tmp/zefron-initdb.log
  fi
  pg_ctl -D "$PGDATA" \
    -o "-h $PGHOST -p $PGPORT -k /tmp" \
    -l "$PGLOG" \
    -w start >/tmp/zefron-pg-start.log
fi

if ! psql -h "$PGHOST" -p "$PGPORT" -U "$PGUSER" -d "$PGDATABASE" -c "select 1" >/dev/null 2>&1; then
  createdb -h "$PGHOST" -p "$PGPORT" -U "$PGUSER" "$PGDATABASE"
fi

if [ -z "${DATABASE_URL:-}" ]; then
  echo "DATABASE_URL is required for the PostgreSQL audio cache" >&2
  exit 1
fi

psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f scripts/audio-cache.sql >/tmp/zefron-schema.log
echo "PostgreSQL audio cache ready at $PGHOST:$PGPORT/$PGDATABASE"