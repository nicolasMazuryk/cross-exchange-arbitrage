# Task 08: Core-box data middleware roles

## Scope
Author the `role_core` data-middleware roles that lay config on the core box (config-on-host only;
Kamal runs the containers — the G6 seam): `chrony` (tight clock sync), `clickhouse` (3-disk tiered
`storage.xml` nvme/volume/s3-NBG1, `limits.xml`, `network.xml` listening `127.0.0.1` + `10.0.1.20`,
`users.d` from SOPS, data dir `/mnt/ch-volume/clickhouse`), and `redpanda` (KRaft, `--smp 2
--memory 5G`, **private listener `10.0.1.20:9092`**, admin `127.0.0.1:9644`, data dir
`/mnt/ch-volume/redpanda`, sizing flags). Schema DDL, topic definitions, and MVs stay with the app —
these roles only install/config/size.

## Spec References
- [03-configuration.md §clickhouse-role](../../specs/infrastructure/03-configuration.md#clickhouse-role), [§redpanda-role](../../specs/infrastructure/03-configuration.md#redpanda-role), [§chrony-role](../../specs/infrastructure/03-configuration.md#chrony-role)
- [06-capacity-and-cost.md §core-box-process-boundaries](../../specs/infrastructure/06-capacity-and-cost.md#core-box-process-boundaries)
- Gap G6 (Ansible↔Kamal seam) — [08-gaps-and-decisions.md §g6](../../specs/infrastructure/08-gaps-and-decisions.md#g6)

## Dependencies
- Depends on: Task 06

## Acceptance Criteria
- [ ] `chrony` role renders the spec's `chrony.conf` (pools, `makestep 0.1 3`, `rtcsync`); contract: host
      within 50 ms of UTC.
- [ ] `clickhouse` role renders `config.d/storage.xml` (tiered nvme/volume/s3 with NBG1 endpoint),
      `config.d/limits.xml` (max_memory 12 GB, max_threads 6, async_insert), `config.d/network.xml`
      (`listen_host` 127.0.0.1 + 10.0.1.20), `users.d` from SOPS; creates `/mnt/ch-volume/clickhouse`.
- [ ] `redpanda` role sets `--smp 2 --memory 5G ... --mode production`, listener `INTERNAL://10.0.1.20:9092`,
      admin/metrics `127.0.0.1:9644`, data dir `/mnt/ch-volume/redpanda`, and the `ob.ticks`/`spreads.live`
      retention/size caps.
- [ ] No schema DDL, topic creation, or MV definitions in these roles (app-owned).

## Verification Criteria (observe it working at runtime)
Prove correctness by running it, not by writing it. State "I ran X, observed Y, matches Z".
- [ ] Apply the core data roles, then on the core box print the rendered `storage.xml`/`limits.xml`/
      `network.xml` and the redpanda config — confirm values match the spec (S3 endpoint, listen_host,
      smp/memory flags).
- [ ] Confirm the volume dirs exist: `ls -ld /mnt/ch-volume/clickhouse /mnt/ch-volume/redpanda` — print it.
- [ ] **Re-run with `--check` and observe `0 changed`** (idempotent) — print the recap. (Running
      containers are verified later in task 13.)

## Out of Scope
- Running the CH/Redpanda containers (Kamal accessories, task 13).
- spread-computer, kamal-proxy, Alloy (task 09).
- ClickHouse schema/tables/MVs and Redpanda topic creation (datapipeline).
