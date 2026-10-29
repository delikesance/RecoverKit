#!/usr/bin/env bash
# Tests de docker/entrypoint.sh SANS Docker, avec le PostgreSQL 16 local.
# Usage : scripts/test-entrypoint.sh   (root : le script se relance en utilisateur « postgres »)
set -uo pipefail

PG_BIN="${PG_BIN:-/usr/lib/postgresql/16/bin}"
SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

if [ "$(id -u)" = 0 ]; then
  command -v runuser >/dev/null || { echo "runuser introuvable" >&2; exit 2; }
  WORK="$(mktemp -d)"
  cp "${ENTRYPOINT_SRC:-$SRC/docker/entrypoint.sh}" "$WORK/entrypoint.sh"
  cp "${BASH_SOURCE[0]}" "$WORK/test.sh"
  chown -R postgres:postgres "$WORK"
  chmod 0755 "$WORK"
  runuser -u postgres -- env ENTRYPOINT="$WORK/entrypoint.sh" PG_BIN="$PG_BIN" bash "$WORK/test.sh"
  code=$?
  rm -rf "$WORK"
  exit "$code"
fi

ENTRYPOINT="${ENTRYPOINT:-$SRC/docker/entrypoint.sh}"
export PATH="$PG_BIN:$PATH"
ROOT="$(mktemp -d)"
EP_PID=""
PASS=0
FAIL=0
SLEEP_N=$((2000 + RANDOM % 5000)) # durée unique : permet de retrouver nos processus factices

cleanup() {
  [ -n "$EP_PID" ] && kill -KILL "$EP_PID" 2>/dev/null
  for d in "$ROOT"/*/data; do [ -f "$d/postmaster.pid" ] && pg_ctl -D "$d" -m immediate stop >/dev/null 2>&1; done
  rm -rf "$ROOT"
}
trap cleanup EXIT

ok() { PASS=$((PASS + 1)); echo "  ok   - $*"; }
ko() { FAIL=$((FAIL + 1)); echo "  FAIL - $*"; }
check() { local desc="$1"; shift; if "$@"; then ok "$desc"; else ko "$desc"; fi; }

free_port() { python3 -I -c 'import socket;s=socket.socket();s.bind(("127.0.0.1",0));print(s.getsockname()[1])'; }

# Prépare un environnement isolé ($1 = nom) : exporte PGDATA, PG_PORT, LOG, etc.
setup() {
  T="$ROOT/$1"; mkdir -p "$T/sock" "$T/app/apps/web"
  export PGDATA="$T/data" PG_SOCKET_DIR="$T/sock" PG_PORT="$(free_port)" APP_DIR="$T/app"
  export LOG="$T/out.log" MIGRATIONS_LOG="$T/migrations.log"
  mkdir -p "$PGDATA"; chmod 0700 "$PGDATA"
  cat > "$T/migrate.sh" <<'EOF'
#!/usr/bin/env bash
psql "$DATABASE_URL" -Atc 'select current_user' >> "$MIGRATIONS_LOG"
EOF
  chmod +x "$T/migrate.sh"
  export MIGRATE_CMD="$T/migrate.sh" WEB_CMD="sleep $SLEEP_N" WORKER_CMD="sleep $SLEEP_N"
  : > "$LOG"
}

start_ep() { bash "$ENTRYPOINT" >> "$LOG" 2>&1 & EP_PID=$!; }
wait_log() { # motif, délai
  local i; for i in $(seq 1 $(( ${2:-60} * 5 ))); do grep -q "$1" "$LOG" && return 0; kill -0 "$EP_PID" 2>/dev/null || return 1; sleep 0.2; done; return 1
}
wait_exit() { # délai : renvoie le code de sortie dans EP_CODE
  local i; for i in $(seq 1 $(( ${1:-30} * 5 ))); do kill -0 "$EP_PID" 2>/dev/null || { wait "$EP_PID"; EP_CODE=$?; EP_PID=""; return 0; }; sleep 0.2; done; return 1
}
psql_rk() { psql -h "$PG_SOCKET_DIR" -p "$PG_PORT" -U postgres -d "${2:-recoverkit}" -Atc "$1"; }
stop_ep() { kill -TERM "$EP_PID" 2>/dev/null; wait_exit 30; }
no_postgres() { [ ! -f "$PGDATA/postmaster.pid" ] && ! pg_isready -q -h "$PG_SOCKET_DIR" -p "$PG_PORT"; }
role_works() { local pw; pw="$(. "$PGDATA/.recoverkit-secrets"; echo "$DB_PASSWORD")"; PGPASSWORD="$pw" psql -h 127.0.0.1 -p "$PG_PORT" -U recoverkit -d recoverkit -Atc 'select 1' 2>/dev/null | grep -q 1; }
no_fakes() { ! pgrep -f "sleep $SLEEP_N" >/dev/null; }
expect_ready() { wait_log "démarrage du site" 60; }

echo "1. premier démarrage"
setup first
start_ep
check "le démarrage va jusqu'au site et au worker" expect_ready
check "marqueur écrit" test -e "$PGDATA/.recoverkit-initialized"
check "secrets présents" test -s "$PGDATA/.recoverkit-secrets"
check "rôle recoverkit utilisable (mot de passe)" role_works
check "migrations lancées avec le rôle recoverkit" grep -qx recoverkit "$MIGRATIONS_LOG"
pw="$(. "$PGDATA/.recoverkit-secrets"; echo "$DB_PASSWORD")"
check "mot de passe absent de la liste des processus" bash -c '! ps -eo args | grep -F -- "$0" | grep -v grep >/dev/null' "$pw"
psql_rk 'create table marqueur as select 42 as v' >/dev/null

echo "2. arrêt propre (SIGTERM)"
stop_ep
check "sortie avec le code 0" test "${EP_CODE:-1}" = 0
check "PostgreSQL arrêté, web et worker terminés" no_postgres
check "plus de processus factice orphelin" no_fakes

echo "3. redémarrage sur le même volume"
: > "$LOG"
secrets_before="$(cat "$PGDATA/.recoverkit-secrets")"
start_ep
check "démarrage complet" expect_ready
check "base déjà initialisée (pas de réinitialisation)" grep -q 'base déjà initialisée' "$LOG"
check "secrets inchangés" test "$secrets_before" = "$(cat "$PGDATA/.recoverkit-secrets")"
check "données conservées" test "$(psql_rk 'select v from marqueur')" = 42
stop_ep

echo "4. arrêt simulé entre initdb et la création du rôle (PG_VERSION sans secrets ni marqueur)"
setup crash1
initdb -D "$PGDATA" -U postgres --encoding=UTF8 --auth-local=trust --auth-host=scram-sha-256 >/dev/null
start_ep
check "le volume est repris et va jusqu'au bout" expect_ready
check "rôle et base créés, mot de passe valide" role_works
check "marqueur écrit après coup" test -e "$PGDATA/.recoverkit-initialized"
stop_ep

echo "5. arrêt simulé après l'écriture des secrets, avant la création du rôle"
setup crash2
initdb -D "$PGDATA" -U postgres --encoding=UTF8 --auth-local=trust --auth-host=scram-sha-256 >/dev/null
printf 'DB_PASSWORD=abc123def\nTOKEN_SECRET_GENERATED=tok456\n' > "$PGDATA/.recoverkit-secrets"
start_ep
check "reprise complète" expect_ready
check "les secrets existants sont réutilisés" grep -q '^DB_PASSWORD=abc123def$' "$PGDATA/.recoverkit-secrets"
check "rôle utilisable avec le mot de passe existant" role_works
stop_ep

echo "6. rôle créé mais base absente (échec de create database)"
setup crash3
initdb -D "$PGDATA" -U postgres --encoding=UTF8 --auth-local=trust --auth-host=scram-sha-256 >/dev/null
printf 'DB_PASSWORD=zzz999\nTOKEN_SECRET_GENERATED=tok789\n' > "$PGDATA/.recoverkit-secrets"
pg_ctl -D "$PGDATA" -w -l "$T/pg.log" -o "-c listen_addresses= -c port=$PG_PORT -c unix_socket_directories=$PG_SOCKET_DIR" start >/dev/null
psql -h "$PG_SOCKET_DIR" -p "$PG_PORT" -U postgres -d postgres -qc "create role recoverkit login password 'ancien'"
pg_ctl -D "$PGDATA" -w -m fast stop >/dev/null
start_ep
check "reprise complète" expect_ready
check "base créée et mot de passe réaligné sur les secrets" role_works
stop_ep

echo "7. initdb interrompu (cluster inutilisable, sans secrets ni donnée) : régénéré proprement"
setup crash4
echo 16 > "$PGDATA/PG_VERSION"; mkdir -p "$PGDATA/base/1"
start_ep
check "le volume est régénéré et le démarrage aboutit" expect_ready
check "rôle utilisable" role_works
check "réinitialisation journalisée" grep -q 'cluster incomplet sans donnée' "$LOG"
stop_ep

echo "8. jamais de destruction : cluster sans marqueur ni secrets mais contenant la base recoverkit"
setup keep
initdb -D "$PGDATA" -U postgres --encoding=UTF8 --auth-local=trust --auth-host=scram-sha-256 >/dev/null
pg_ctl -D "$PGDATA" -w -l "$T/pg.log" -o "-c listen_addresses= -c port=$PG_PORT -c unix_socket_directories=$PG_SOCKET_DIR" start >/dev/null
psql -h "$PG_SOCKET_DIR" -p "$PG_PORT" -U postgres -d postgres -qc "create database recoverkit"
psql -h "$PG_SOCKET_DIR" -p "$PG_PORT" -U postgres -d recoverkit -qc "create table donnees_metier as select 7 as v"
pg_ctl -D "$PGDATA" -w -m fast stop >/dev/null
start_ep
check "démarrage complet" expect_ready
check "données métier conservées" test "$(psql_rk 'select v from donnees_metier')" = 7
check "rôle utilisable" role_works
stop_ep

echo "9. marqueur présent mais secrets perdus : échec explicite, rien n'est détruit"
setup nosecrets
start_ep; expect_ready >/dev/null; stop_ep
rm -f "$PGDATA/.recoverkit-secrets"
: > "$LOG"
start_ep
wait_exit 30
check "sortie en erreur" test "${EP_CODE:-0}" != 0
check "message explicite" grep -q 'ERREUR' "$LOG"
check "données intactes" test -s "$PGDATA/PG_VERSION"

echo "10. un processus meurt : le conteneur sort et arrête les autres"
setup die
printf '#!/usr/bin/env bash\nsleep 2\nexit 7\n' > "$T/worker.sh"; chmod +x "$T/worker.sh"
export WORKER_CMD="$T/worker.sh"
start_ep
check "démarrage" expect_ready
wait_exit 30
check "sortie avec le code du processus mort (7)" test "${EP_CODE:-0}" = 7
check "PostgreSQL arrêté" no_postgres
check "le site a été arrêté" no_fakes

echo "11. PostgreSQL meurt : le conteneur sort"
setup pgdie
start_ep
check "démarrage" expect_ready
kill -KILL "$(head -1 "$PGDATA/postmaster.pid")" 2>/dev/null
wait_exit 40
check "le conteneur sort en erreur" test "${EP_CODE:-0}" != 0
check "le site a été arrêté" no_fakes

echo
echo "Résultat : $PASS réussis, $FAIL échoués"
[ "$FAIL" = 0 ]
