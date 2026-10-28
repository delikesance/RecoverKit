#!/usr/bin/env bash
# Supervise PostgreSQL, le site et le worker dans un seul conteneur.
# Si un des trois s'arrête, les autres sont arrêtés proprement et le conteneur sort avec le même code.
set -euo pipefail

APP_DIR="${APP_DIR:-/app}"
PGDATA="${PGDATA:-/var/lib/postgresql/data}"
PG_SOCKET_DIR="${PG_SOCKET_DIR:-/tmp}"
PG_PORT="${PG_PORT:-5432}"
PG_DB=recoverkit
PG_USER=recoverkit
SECRETS_FILE="$PGDATA/.recoverkit-secrets"
WEB_CMD="${WEB_CMD:-$APP_DIR/node_modules/.bin/next start -p ${PORT:-3000} -H 0.0.0.0}"
WORKER_CMD="${WORKER_CMD:-$APP_DIR/node_modules/.bin/tsx $APP_DIR/apps/worker/src/main.ts}"
MIGRATE_CMD="${MIGRATE_CMD:-$APP_DIR/node_modules/.bin/tsx $APP_DIR/packages/db/src/migrate-cli.ts}"

log() { printf '[entrypoint] %s\n' "$*"; }
random_hex() { head -c "$1" /dev/urandom | od -An -tx1 | tr -d ' \n'; }

# ── 1. Initialisation de la base au premier démarrage ───────────────────────
if [ ! -s "$PGDATA/PG_VERSION" ]; then
  log "volume vide : initialisation de PostgreSQL"
  initdb -D "$PGDATA" -U postgres --encoding=UTF8 --auth-local=trust --auth-host=scram-sha-256 >/dev/null
  DB_PASSWORD="$(random_hex 24)"
  umask 077
  printf 'DB_PASSWORD=%s\nTOKEN_SECRET_GENERATED=%s\n' "$DB_PASSWORD" "$(random_hex 32)" > "$SECRETS_FILE"
  FIRST_START=1
else
  log "base déjà initialisée"
  FIRST_START=0
fi
# shellcheck disable=SC1090
. "$SECRETS_FILE"

# ── 2. PostgreSQL : local au conteneur, jamais exposé ───────────────────────
postgres -D "$PGDATA" -c listen_addresses=127.0.0.1 -c port="$PG_PORT" -c unix_socket_directories="$PG_SOCKET_DIR" &
PG_PID=$!
WEB_PID=""
WORKER_PID=""
STOPPING=0

stop_all() {
  [ "$STOPPING" = 1 ] && return
  STOPPING=1
  log "arrêt en cours"
  [ -n "$WEB_PID" ] && kill -TERM "$WEB_PID" 2>/dev/null || true
  [ -n "$WORKER_PID" ] && kill -TERM "$WORKER_PID" 2>/dev/null || true
  [ -n "$WEB_PID" ] && wait "$WEB_PID" 2>/dev/null || true
  [ -n "$WORKER_PID" ] && wait "$WORKER_PID" 2>/dev/null || true
  # SIGINT = arrêt « fast » de PostgreSQL
  kill -INT "$PG_PID" 2>/dev/null || true
  wait "$PG_PID" 2>/dev/null || true
}
trap 'stop_all; exit 0' TERM INT

for _ in $(seq 1 60); do
  pg_isready -q -h "$PG_SOCKET_DIR" -p "$PG_PORT" && break
  kill -0 "$PG_PID" 2>/dev/null || { log "PostgreSQL s'est arrêté au démarrage"; exit 1; }
  sleep 1
done
pg_isready -q -h "$PG_SOCKET_DIR" -p "$PG_PORT" || { log "PostgreSQL ne répond pas"; stop_all; exit 1; }

PSQL=(psql -h "$PG_SOCKET_DIR" -p "$PG_PORT" -U postgres -v ON_ERROR_STOP=1 -q)
if [ "$FIRST_START" = 1 ]; then
  "${PSQL[@]}" -d postgres -v pw="$DB_PASSWORD" <<SQL
create role $PG_USER login password :'pw';
create database $PG_DB owner $PG_USER encoding 'UTF8';
SQL
fi

# ── 3. Configuration dérivée ────────────────────────────────────────────────
export DATABASE_URL="postgresql://$PG_USER:$DB_PASSWORD@127.0.0.1:$PG_PORT/$PG_DB"
export TOKEN_SECRET="${TOKEN_SECRET:-$TOKEN_SECRET_GENERATED}"

# ── 4. Migrations (verrou consultatif : sûr si plusieurs démarrages) ────────
log "migrations"
( cd "$APP_DIR" && $MIGRATE_CMD ) || { log "migrations échouées"; stop_all; exit 1; }

# ── 5. Site et worker ───────────────────────────────────────────────────────
log "démarrage du site (port ${PORT:-3000}) et du worker"
( cd "$APP_DIR/apps/web" && exec $WEB_CMD ) &
WEB_PID=$!
( cd "$APP_DIR" && exec $WORKER_CMD ) &
WORKER_PID=$!

set +e
wait -n "$PG_PID" "$WEB_PID" "$WORKER_PID"
CODE=$?
set -e
log "un processus s'est arrêté (code $CODE)"
stop_all
exit "$CODE"
