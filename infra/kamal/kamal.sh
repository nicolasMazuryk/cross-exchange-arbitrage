#!/usr/bin/env bash
# Dockerized Kamal wrapper (task 13).
#
# Why: the host ruby is 2.6 (kamal needs 3.x) and there's no homebrew ruby, so
# kamal runs in the `arbinet-kamal` image (Dockerfile.kamal = stock kamal + pinned
# sops/age). This script wires everything that image needs at runtime:
#   - repo root mounted at /workdir (kamal reads config/deploy.yml + .kamal/secrets)
#   - host docker socket  -> kamal builds/runs containers via the host daemon
#   - operator SSH key + known_hosts -> reach the private-net hosts (over WireGuard)
#   - operator age key    -> `.kamal/secrets` shells out to `sops -d` against the vault
#   - VERSION=<git short SHA> -> image tag (worktree .git isn't mounted in-container)
#
# Security posture: this container has the host DOCKER SOCKET, so it must NOT also
# see the whole ~/.ssh keyring. We mount ONLY the single operator key (~/.ssh/nicolas)
# and run as the host uid, so kamal's net-ssh reads the key straight from a host-owned
# file with no in-container root/chmod rewrite. (net-ssh is pure ruby: it ignores
# GIT_SSH and openssh `-o` flags and enforces key-owner == process-uid, which is why
# we match uid rather than pass ssh options. deploy.yml `ssh.keys: ~/.ssh/nicolas`
# resolves against HOME below.)
#
# Run from the repo root:  infra/kamal/kamal.sh <kamal-args...>   (e.g. config, deploy)
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
AGE_KEY_FILE="${SOPS_AGE_KEY_FILE:-$HOME/.config/sops/age/keys.txt}"
SSH_KEY_FILE="$HOME/.ssh/nicolas"

cd "$REPO_ROOT"

if [[ ! -f "$AGE_KEY_FILE" ]]; then
  echo "kamal.sh: age key not found at $AGE_KEY_FILE (set SOPS_AGE_KEY_FILE)" >&2
  exit 1
fi
if [[ ! -f "$SSH_KEY_FILE" ]]; then
  echo "kamal.sh: operator SSH key not found at $SSH_KEY_FILE" >&2
  exit 1
fi

# Tag the wrapper image by Dockerfile.kamal content hash, so editing the Dockerfile
# yields a new tag and triggers a rebuild instead of silently reusing a stale image.
DOCKERFILE="docker/Dockerfile.kamal"
IMAGE_HASH="$(shasum "$DOCKERFILE" | cut -c1-12)"
IMAGE="arbinet-kamal:$IMAGE_HASH"
if ! docker image inspect "$IMAGE" >/dev/null 2>&1; then
  echo "kamal.sh: building $IMAGE ..." >&2
  docker build -t "$IMAGE" -f "$DOCKERFILE" docker/
fi

VERSION="$(git rev-parse --short HEAD)"

# Single-instance trader guard for the `app boot` / `app start` escape hatch.
# `deploy`/`redeploy`/`rollback` go through `.kamal/hooks/pre-deploy` (stops the trader
# before the new container boots); the lower-level `app boot`/`app start` do NOT fire
# that hook, so guard them here on the host. Stop the running trader first when these
# subcommands target it: no `--roles` (all roles → includes trader) or a `--roles=…`
# list naming `trader`. Everything else (deploy family, config, secrets, accessory,
# app stop/details, …) passes straight through unchanged.
guard_app_boot_start() {
  local sub1="${1:-}" sub2="${2:-}"
  [[ "$sub1" == "app" && ( "$sub2" == "boot" || "$sub2" == "start" ) ]] || return 0
  local arg roles=""
  for arg in "$@"; do
    case "$arg" in
      --roles=*) roles="${arg#--roles=}" ;;
    esac
  done
  # No --roles → all roles (trader included). With --roles, only when the list names trader.
  if [[ -z "$roles" || ",$roles," == *",trader,"* ]]; then
    echo "kamal.sh: '$sub1 $sub2' targets the trader → running stop-first guard" >&2
    "$REPO_ROOT/infra/kamal/stop-trader.sh"
  fi
}
guard_app_boot_start "$@"

# Per-run writable HOME with ONLY the operator key (not the whole ~/.ssh). Copy the
# single key in (mode 600) so net-ssh's owner/perm check passes when we run as the host
# uid; seed known_hosts from the host's so the prod host keys (already trusted over WG)
# verify, and leave it writable so net-ssh can append any new host. The age key is bind-
# mounted read-only — sops reads it by path and does not owner-check, so no copy needed.
KHOME="$(mktemp -d)"
cleanup() { rm -rf "$KHOME"; }
trap cleanup EXIT
mkdir -p "$KHOME/.ssh"
install -m 600 "$SSH_KEY_FILE" "$KHOME/.ssh/nicolas"
if [[ -f "$HOME/.ssh/known_hosts" ]]; then
  install -m 644 "$HOME/.ssh/known_hosts" "$KHOME/.ssh/known_hosts"
else
  : > "$KHOME/.ssh/known_hosts"
fi

# Give the host uid a passwd entry. The `.kamal/hooks/pre-deploy` hook (single-instance
# trader guard) shells out to the openssh `ssh` CLI, which calls getpwuid(getuid()) at
# startup and FATALS "No user exists for uid <n>" when the uid we run as (--user, the
# host uid) has no /etc/passwd entry. (kamal's own net-ssh is pure-ruby and tolerates a
# missing entry; the openssh CLI does not.) Append our uid to the image's real passwd
# (don't replace it — keep the image's system users) and bind-mount it read-only.
docker run --rm --entrypoint sh "$IMAGE" -c 'cat /etc/passwd' > "$KHOME/passwd"
printf 'kamaluser:x:%s:%s::/khome:/bin/bash\n' "$(id -u)" "$(id -g)" >> "$KHOME/passwd"

# Resolve the gid owning the bind-mounted docker socket *inside* the container so we can add it
# as a supplementary group below. We run as the host uid (--user, for net-ssh's key-owner==uid
# check), but the socket is root:<docker-gid> mode 660 → the host uid needs that gid to reach the
# daemon, else kamal's `docker buildx` (docker-container driver) build fails "permission denied".
# gid is 0 on Docker Desktop (macOS), the real docker-group gid (e.g. 999) on Linux → resolve it.
SOCK_GID="$(docker run --rm \
  -v /var/run/docker.sock:/var/run/docker.sock \
  --entrypoint stat "$IMAGE" -c %g /var/run/docker.sock 2>/dev/null || true)"
if [[ ! "$SOCK_GID" =~ ^[0-9]+$ ]]; then
  echo "kamal.sh: WARNING: could not resolve docker socket gid (got '${SOCK_GID:-}')," \
       "falling back to 0; in-container buildx may fail with permission denied." >&2
  SOCK_GID=0
fi

TTY_FLAG=()
[[ -t 0 ]] && TTY_FLAG=(-it)

docker run --rm "${TTY_FLAG[@]}" \
  --user "$(id -u):$(id -g)" \
  --group-add "$SOCK_GID" \
  -v "$REPO_ROOT:/workdir" -w /workdir \
  -v "$KHOME:/khome" \
  -v "$KHOME/passwd:/etc/passwd:ro" \
  -v "$AGE_KEY_FILE:/age-key:ro" \
  -v /var/run/docker.sock:/var/run/docker.sock \
  -e HOME=/khome \
  -e SOPS_AGE_KEY_FILE=/age-key \
  -e VERSION="$VERSION" \
  --entrypoint kamal \
  "$IMAGE" "$@"
