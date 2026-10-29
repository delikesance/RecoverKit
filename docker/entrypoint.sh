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

# ── 1. Initialisation de la base ────────────────────────────────────────────
# Le marqueur n'est écrit qu'APRÈS la création du rôle et de la base : PG_VERSION (écrit très tôt par
# initdb) ne prouve rien. Sans marqueur, chaque étape est rejouée de façon idempotente.
MARKER="$PGDATA/.recoverkit-initialized"

secrets_valid() {
  [ -s "$SECRETS_FILE" ] && ( . "$SECRETS_FILE" && [ -n "${DB_PASSWORD:-}" ] && [ -n "${TOKEN_SECRET_GENERATED:-}" ] ) 2>/dev/null
}

write_secrets() {
  local tmp="$SECRETS_FILE.tmp"
  ( umask 077
    printf 'DB_PASSWORD=%s\nTOKEN_SECRET_GENERATED=%s\n' "$(random_hex 24)" "$(random_hex 32)" > "$tmp" )
  mv -f "$tmp" "$SECRETS_FILE"
}

run_initdb() {
  log "volume vide : initialisation de PostgreSQL"
  initdb -D "$PGDATA" -U postgres --encoding=UTF8 --auth-local=trust --auth-host=scram-sha-256 >/dev/null
}

# Un cluster sans marqueur ne peut être refait que s'il ne contient aucune base utilisateur
# (initdb crée trois bases : template0, template1, postgres).
cluster_is_pristine() {
  local n
  n="$(find "$PGDATA/base" -mindepth 1 -maxdepth 1 -type d 2>/dev/null | wc -l)"
  [ "$n" -le 3 ]
}

wipe_pgdata() { find "$PGDATA" -mindepth 1 -delete; }

if [ -e "$MARKER" ]; then
  log "base déjà initialisée"
  secrets_valid || { log "ERREUR : $SECRETS_FILE absent ou illisible alors que la base est initialisée ; restaurer le volume"; exit 1; }
elif [ ! -s "$PGDATA/PG_VERSION" ]; then
  run_initdb
  write_secrets
else
  log "initialisation précédente incomplète : reprise"
  secrets_valid || write_secrets
fi
# shellcheck disable=SC1090
. "$SECRETS_FILE"

# ── 2. PostgreSQL : local au conteneur, jamais exposé ───────────────────────
PG_PID=""
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
  [ -n "$PG_PID" ] && kill -INT "$PG_PID" 2>/dev/null || true
  [ -n "$PG_PID" ] && wait "$PG_PID" 2>/dev/null || true
}
trap 'stop_all; exit 0' TERM INT

# Retour : 0 prêt, 1 le processus s'est arrêté, 2 délai dépassé.
start_postgres() {
  postgres -D "$PGDATA" -c listen_addresses=127.0.0.1 -c port="$PG_PORT" -c unix_socket_directories="$PG_SOCKET_DIR" &
  PG_PID=$!
  for _ in $(seq 1 60); do
    pg_isready -q -h "$PG_SOCKET_DIR" -p "$PG_PORT" && return 0
    kill -0 "$PG_PID" 2>/dev/null || { wait "$PG_PID" 2>/dev/null || true; PG_PID=""; return 1; }
    sleep 1
  done
  return 2
}

STATUS=0
start_postgres || STATUS=$?
if [ "$STATUS" = 1 ] && [ ! -e "$MARKER" ] && cluster_is_pristine; then
  # initdb interrompu : le cluster est inutilisable et ne contient aucune donnée, on le refait.
  log "cluster incomplet sans donnée : réinitialisation"
  wipe_pgdata
  run_initdb
  write_secrets
  # shellcheck disable=SC1090
  . "$SECRETS_FILE"
  STATUS=0
  start_postgres || STATUS=$?
fi
case "$STATUS" in
  0) ;;
  1) log "PostgreSQL s'est arrêté au démarrage"; exit 1 ;;
  *) log "PostgreSQL ne répond pas"; stop_all; exit 1 ;;
esac

# Rôle et base : création idempotente. Le mot de passe passe par l'entrée standard de psql
# (jamais en argument : il serait visible dans la liste des processus).
if [ ! -e "$MARKER" ]; then
  psql -h "$PG_SOCKET_DIR" -p "$PG_PORT" -U postgres -d postgres -v ON_ERROR_STOP=1 -q <<SQL || { log "création du rôle ou de la base échouée"; stop_all; exit 1; }
\set pw '$DB_PASSWORD'
select exists (select 1 from pg_roles where rolname = '$PG_USER') as role_exists \gset
\if :role_exists
alter role $PG_USER login password :'pw';
\else
create role $PG_USER login password :'pw';
\endif
select exists (select 1 from pg_database where datname = '$PG_DB') as db_exists \gset
\if :db_exists
\else
create database $PG_DB owner $PG_USER encoding 'UTF8';
\endif
SQL
  : > "$MARKER"
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
