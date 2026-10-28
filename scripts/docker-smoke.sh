#!/usr/bin/env bash
# Test de fumée de l'image tout-en-un. Usage : scripts/docker-smoke.sh <image>
set -euo pipefail
IMAGE="${1:?usage: docker-smoke.sh <image>}"
NAME="rk-smoke-$$"
VOLUME="rk-smoke-data-$$"
HOST_PORT="${HOST_PORT:-38080}"

cleanup() {
  docker logs "$NAME" 2>&1 | tail -60 || true
  docker rm -f "$NAME" >/dev/null 2>&1 || true
  docker volume rm -f "$VOLUME" >/dev/null 2>&1 || true
}
trap cleanup EXIT

fail() { echo "ÉCHEC : $*" >&2; exit 1; }

run() {
  docker run -d --name "$NAME" -p "$HOST_PORT:3000" -v "$VOLUME:/var/lib/postgresql/data" \
    -e APP_URL=https://app.example.test \
    -e STRIPE_SECRET_KEY=sk_test_smoke \
    -e STRIPE_CONNECT_WEBHOOK_SECRET=whsec_smoke_connect \
    -e STRIPE_PLATFORM_WEBHOOK_SECRET=whsec_smoke_platform \
    -e STRIPE_CONNECT_CLIENT_ID=ca_smoke \
    -e RESEND_API_KEY=re_smoke \
    -e SYSTEM_FROM_EMAIL=no-reply@example.test \
    "$IMAGE" >/dev/null
}

wait_healthy() {
  for _ in $(seq 1 90); do
    code="$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$HOST_PORT/api/health" || true)"
    [ "$code" = 200 ] && return 0
    [ "$(docker inspect -f '{{.State.Running}}' "$NAME")" = true ] || fail "le conteneur s'est arrêté"
    sleep 2
  done
  fail "/api/health ne répond pas 200 (dernier code : $code)"
}

# 1. Un seul port exposé, en TCP, et pas d'utilisateur root.
ports="$(docker image inspect "$IMAGE" --format '{{json .Config.ExposedPorts}}')"
[ "$ports" = '{"3000/tcp":{}}' ] || fail "ports exposés inattendus : $ports"
user="$(docker image inspect "$IMAGE" --format '{{.Config.User}}')"
{ [ -n "$user" ] && [ "$user" != root ] && [ "$user" != 0 ]; } || fail "l'image tourne en root"

# 2. Premier démarrage : initialisation, migrations, santé (/api/health interroge la base).
run
wait_healthy
migrations="$(docker exec "$NAME" psql -h /tmp -U postgres -d recoverkit -Atc 'select count(*) from schema_migrations')"
[ "$migrations" -ge 1 ] || fail "aucune migration appliquée"
psql_in() { docker exec "$NAME" psql -h /tmp -U postgres -d recoverkit -Atc "$1"; }
psql_in 'create table smoke_marker as select 42 as v' >/dev/null

# 3. Hors loopback, seul le port 3000 (0x0BB8) écoute.
external="$(docker exec "$NAME" bash -c "awk 'NR>1 && \$4==\"0A\" {print \$2}' /proc/net/tcp /proc/net/tcp6" \
  | grep -v -E '^(0100007F|0000000000000000FFFF00000100007F|00000000000000000000000001000000):' | sort -u || true)"
unexpected="$(printf '%s\n' "$external" | grep -v -E ':0BB8$' | grep . || true)"
[ -z "$unexpected" ] || fail "port d'écoute inattendu hors loopback : $unexpected"

# 4. Arrêt propre, puis redémarrage sur le même volume : pas de réinitialisation, migrations idempotentes.
docker stop -t 30 "$NAME" >/dev/null
exit_code="$(docker inspect -f '{{.State.ExitCode}}' "$NAME")"
[ "$exit_code" = 0 ] || fail "arrêt non propre (code $exit_code)"
docker rm "$NAME" >/dev/null
run
wait_healthy
docker logs "$NAME" 2>&1 | grep -q 'base déjà initialisée' || fail "le volume n'a pas été réutilisé"
[ "$(psql_in 'select v from smoke_marker')" = 42 ] || fail "les données n'ont pas survécu au redémarrage"
echo "OK : image saine (port unique 3000, base intégrée, persistance et redémarrage)"
