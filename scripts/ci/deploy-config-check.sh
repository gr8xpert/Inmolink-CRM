#!/usr/bin/env bash
# Validates the deploy configuration with the real tools (S0-15). CI job `deploy-config`; locally:
#   docker run --rm -v "$PWD:/repo" -w /repo python:3.13-slim@sha256:70729b46c69b4f1e97c4822c1af3df53a1476cf5ddc6c087c0c10bc3a5678c2f bash scripts/ci/deploy-config-check.sh ansible
#   docker run --rm -v "$PWD:/repo" -w /repo ruby:3.4-slim@sha256:c12225b6a73743f943530d9e610f4ae78e0dbcffdcf797b01522a55f7d25acb3 bash scripts/ci/deploy-config-check.sh kamal
#   ansible: `ansible-playbook --syntax-check` for both inventories + rendering of every template
#   kamal:   `kamal config` for every app × destination, with dummy values for the referenced secrets
set -euo pipefail

ANSIBLE_CORE_VERSION=2.19.3
KAMAL_VERSION=2.12.0
root="$(cd "$(dirname "$0")/../.." && pwd)"

check_ansible() {
  pip install --quiet --disable-pip-version-check "ansible-core==$ANSIBLE_CORE_VERSION"
  cd "$root/infra/ansible"
  export ANSIBLE_CONFIG="$PWD/ansible.cfg"
  ansible-galaxy collection install --upgrade -r requirements.yml >/dev/null
  for env in staging production; do
    ansible-playbook -i "inventories/$env" site.yml --syntax-check
    # Render every template offline with the example vault, as each host would see it.
    ansible-playbook -i "inventories/$env" ci-render.yml -e "@inventories/$env/group_vars/all/vault.example.yml"
  done
  test "$(find /tmp/ansible-render -type f | wc -l)" -gt 20
  grep -q "PublicKey = ci-pubkey-db-1" /tmp/ansible-render/production/db-2/wg0.conf
  grep -q "host    replication     replicator          10.10.0.31/32" /tmp/ansible-render/production/db-1/pg_hba.conf
  grep -q "role: replica" /tmp/ansible-render/production/db-2/prometheus.yml
}

check_kamal() {
  gem install --silent --no-document kamal -v "$KAMAL_VERSION" >/dev/null
  cd "$root"
  # This writes and then deletes .kamal/secrets.<dest>: never on a checkout that holds real ones.
  for dest in staging production; do
    if [ -e ".kamal/secrets.$dest" ]; then
      echo "deploy-config-check: .kamal/secrets.$dest exists; run this on a clean checkout (CI) only" >&2
      exit 2
    fi
  done
  tmp="$(mktemp -d)"
  trap 'rm -f .kamal/secrets.staging .kamal/secrets.production; rm -rf "$tmp"' EXIT
  for dest in staging production; do cp .kamal/secrets.example ".kamal/secrets.$dest"; done
  # Every `KEY=$KEY` reference gets a dummy value, so kamal resolves the secrets without real ones.
  while IFS= read -r key; do export "$key=dummy-$key"; done < <(grep -oE '^[A-Z0-9_]+' .kamal/secrets.example)
  for config in infra/kamal/*.yml; do
    case "$config" in *.staging.yml|*.production.yml) continue ;; esac
    for dest in staging production; do
      kamal config -c "$config" -d "$dest" --version 0000000000000000000000000000000000000000 >"$tmp/out.yml"
      echo "kamal config ok: $config -d $dest"
    done
  done
}

case "${1:-}" in
  ansible) check_ansible ;;
  kamal) check_kamal ;;
  *) echo "usage: $0 ansible|kamal" >&2; exit 2 ;;
esac
