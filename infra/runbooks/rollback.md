# Rollback

Revert a bad app release. **Data is safe** — ClickHouse + Redpanda persist on the
core box's `/mnt/ch-volume`; rollback swaps the **app image only**, never data.
Source: [spec 07 §Rollback](../../framework/specs/infrastructure/07-runbooks.md).

## 1. Roll the app image back

```bash
infra/kamal/kamal.sh rollback              # → previous tag
# or, if no prior container to roll to:
infra/kamal/kamal.sh app stop
# then redeploy the known-good tag:
git checkout <good-sha> && infra/kamal/kamal.sh deploy
```

Roll back only the affected app(s): `trader` on hot, `query-api` /
`spread-computer` on core (`--roles=<role>`). `trader` is stop-before-start, so
expect a brief trading gap — acceptable, never run two traders.

## 2. Data persists

CH + Redpanda accessories are untouched by an app rollback — their volumes live
on `/mnt/ch-volume`. Do **not** `kamal accessory remove` during a rollback.

## 3. If the cause was a bad schema migration

App tables/MVs are **app-owned DDL** (datapipeline migration tasks), not Kamal.
Rolling the image back does NOT revert applied DDL — coordinate the SQL revert
separately (drop/re-create the affected MV per the datapipeline migration notes).
A rolled-back app reading a forward-migrated schema may still misbehave; match
the schema version to the image.

## 4. Re-run the smoke test

[deploy.md#4-smoke-test](./deploy.md) — `/up` on all apps, `arbinet` db +
`migrations` table present, single-instance trader confirmed, obs targets `up`.
</content>
