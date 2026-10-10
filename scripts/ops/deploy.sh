#!/usr/bin/env bash
# scripts/ops/deploy.sh <staging|production> [--version <git sha>] [--bootstrap-roles] [--only <app,...>]
#
# Zero-downtime deploy of every app (S0-15, docs/runbooks/deploy.md). Run from an operator machine (the
# admin SSH key reaches db hosts; the CI deploy key reaches app hosts only):
#   1. database: one-off worker-image container on the primary db host runs migrations, applies RLS from
#      the tenant registry and runs the guard (packages/db/dist/cli/deploy.js), with owner credentials that
#      never reach the app hosts (/etc/inmolink/migrate.env, written by Ansible). --bootstrap-roles also
#      sends DATABASE_URL_ADMIN from your shell over stdin (first deploy, role-password rotation); the
#      superuser password is never stored on the hosts
#   2. kamal deploy per app, workers first (they must understand events the new API emits), web last
# Images are built by CI for every commit on main; this script never builds. Migrations must stay
# backwards-compatible with the running release (expand → deploy → contract), PLAN §18.
set -euo pipefail

usage() { sed -n '2,3p' "$0" >&2; exit 2; }
[ $# -ge 1 ] || usage
dest="$1"; shift
case "$dest" in staging|production) ;; *) usage ;; esac

version="$(git rev-parse HEAD)"
bootstrap=false
only=""
while [ $# -gt 0 ]; do
  case "$1" in
    --version) version="$2"; shift 2 ;;
    --bootstrap-roles) bootstrap=true; shift ;;
    --only) only="$2"; shift 2 ;;
    *) usage ;;
  esac
done
[[ "$version" =~ ^[0-9a-f]{40}$ ]] || { echo "deploy: --version must be a full 40-char git sha" >&2; exit 2; }

root="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$root"
apps=(worker api feed-api realtime public web)
if [ -n "$only" ]; then IFS=',' read -r -a apps <<<"$only"; fi
for app in "${apps[@]}"; do
  [ -f "infra/kamal/$app.yml" ] || { echo "deploy: no Kamal config for '$app'" >&2; exit 2; }
done

# Primary db host = first host of db_primary in the Ansible inventory (the source of truth after a failover).
db_host="$(pnpm -s exec tsx scripts/ops/inventory.ts "$dest" db_primary | head -1)"
[ -n "$db_host" ] || { echo "deploy: no db_primary host in infra/ansible/inventories/$dest/hosts.yml" >&2; exit 1; }

export RELEASE="$version"
image="ghcr.io/gr8xpert/inmolink-worker:$version"

echo "==> [$dest] migrations + RLS on $db_host with $image"
run_db="docker run --rm --network host --env-file /etc/inmolink/migrate.env"
if $bootstrap; then
  : "${DATABASE_URL_ADMIN:?--bootstrap-roles needs DATABASE_URL_ADMIN (postgres://postgres:…@127.0.0.1:5432/inmolink) in your shell}"
  # shellcheck disable=SC2029 # expanded locally on purpose: the values are this script's own.
  printf 'DATABASE_URL_ADMIN=%s
' "$DATABASE_URL_ADMIN" |
    ssh "deploy@$db_host" "$run_db --env-file /dev/stdin --workdir /repo $image node packages/db/dist/cli/deploy.js"
else
  # shellcheck disable=SC2029
  ssh "deploy@$db_host" "$run_db --workdir /repo $image node packages/db/dist/cli/deploy.js"
fi

for app in "${apps[@]}"; do
  echo "==> [$dest] kamal deploy $app @ $version"
  kamal deploy -c "infra/kamal/$app.yml" -d "$dest" --skip-push --version "$version"
done
echo "==> [$dest] deployed $version: ${apps[*]}"
