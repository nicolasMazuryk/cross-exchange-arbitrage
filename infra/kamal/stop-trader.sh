#!/usr/bin/env bash
# Stop-before-start guard for the single-instance `trader` role.
#
# Why: the trader is a hard single-instance role (spec 04 §single-instance-trader) —
# two concurrent traders place the SAME hedged orders → duplicate trades and real
# financial loss. Kamal's normal (re)boot is rolling (boot-new → wait-healthy →
# stop-old), which runs 2 trader containers concurrently for several seconds. Kamal
# has no per-role "stop-first" toggle, so we force it: remove the running trader
# BEFORE kamal boots the new one. Count goes 1 → 0 → 1, never 2. Brief trader
# downtime is accepted by spec; overlap is not.
#
# `docker rm -f` (not bare `stop`): a stopped same-named container collides with
# kamal's next `docker run --name arbinet-trader-<sha>`. Removing it lets kamal boot
# a fresh container with no name clash and no overlap.
#
# Idempotent / no-op when nothing is running, so it's safe on a first deploy.
# Runs over SSH to the hot box. $HOME/.ssh/nicolas resolves both on the host
# (/Users/nicolas/.ssh/nicolas) and inside the kamal wrapper container
# (/khome/.ssh/nicolas, copied in by kamal.sh) → one script, two execution contexts.
set -euo pipefail

TRADER_HOST="${TRADER_HOST:-10.0.1.10}"
SSH_KEY="${SSH_KEY:-$HOME/.ssh/nicolas}"
SSH_USER="${SSH_USER:-ansible}"

# The `ansible` user is in the `docker` group → docker over SSH needs no sudo.
# Trader containers carry labels service=arbinet + role=trader; accessories use a
# different `service` label, so this filter targets the trader cleanly and never
# touches clickhouse/redpanda. xargs -r → no-op when the ps list is empty.
REMOTE_CMD='docker ps -q --filter label=service=arbinet --filter label=role=trader --filter status=running | xargs -r docker rm -f'

echo "stop-trader: removing any running trader on ${TRADER_HOST} (pre-boot single-instance guard)" >&2

# Filter OpenSSH's post-quantum warning noise from stderr (see infra/CLAUDE.md).
STOPPED="$(
  ssh -i "$SSH_KEY" -o BatchMode=yes -o ConnectTimeout=10 \
    "${SSH_USER}@${TRADER_HOST}" "$REMOTE_CMD" \
    2> >(grep -v "post-quantum\|store now\|may need\|openssh.com/pq" >&2)
)"

if [[ -n "$STOPPED" ]]; then
  echo "stop-trader: removed container(s): $STOPPED" >&2
else
  echo "stop-trader: no running trader to remove (no-op)" >&2
fi
