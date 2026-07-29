# Volume expand (no downtime)

`disk_low` fires at < 40 GB free on `/mnt/ch-volume` (~80 % of the starting
200 GB). Hetzner grows the block device online; we grow the filesystem on top.
Source: [spec 07 §Volume-expand](../../framework/specs/infrastructure/07-runbooks.md),
[spec 06 §scaling-triggers](../../framework/specs/infrastructure/06-capacity-and-cost.md#scaling-triggers).
Tunnel up.

> **Irreversible + billed:** Hetzner Volumes **cannot shrink**. Each bump raises
> the monthly cost. Bump one step at a time (200 → 400, later → 600) and confirm
> the fill trend justifies it.

## 1. Bump the Volume size in Terraform

```bash
set -a; source .env; set +a
export TF_VAR_hcloud_token="$HCLOUD_TOKEN"
export AWS_ACCESS_KEY_ID="$S3_ACCESS_KEY" AWS_SECRET_ACCESS_KEY="$S3_SECRET_KEY"
# edit the core Volume `size` (e.g. 200 → 400) in infra/terraform
terraform -chdir=infra/terraform plan      # expect ONE in-place Volume size update
terraform -chdir=infra/terraform apply
```

Hetzner grows the attached block device live (no detach, no reboot).

## 2. Grow the filesystem on the core box

```bash
ssh -i ~/.ssh/nicolas ansible@10.0.1.20
lsblk                                       # find the Volume device (by-id under /dev/disk/by-id/scsi-0HC_Volume_*)
sudo resize2fs /dev/disk/by-id/scsi-0HC_Volume_<id>   # ext4
# (xfs instead → sudo xfs_growfs /mnt/ch-volume)
df -h /mnt/ch-volume                        # new size reflected
```

## 3. Confirm in Prometheus / Grafana

```bash
curl -sG 10.0.1.30:9090/api/v1/query --data-urlencode \
  'query=node_filesystem_size_bytes{mountpoint="/mnt/ch-volume"}'
```

Compare **before vs after** — the gauge should reflect the new size; `disk_low`
clears. (The obs Volume `/mnt/obs-data` follows the same procedure, 40 → 90 GB.)

## 4. If recurring

Revisit retention vs. the cold-tier triggers
([scaling-triggers.md](./scaling-triggers.md)) before expanding again — reaching
the full 3-day-hot retention assumes the Volume has grown toward the ~370 GB
end-state.
</content>
