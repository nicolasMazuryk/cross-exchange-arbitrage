output "id" {
  description = "Server ID."
  value       = hcloud_server.this.id
}

output "private_ip" {
  description = "Server static private IP."
  value       = var.private_ip
}

output "public_ipv4" {
  description = "Server public IPv4 (for operator SSH verification)."
  value       = hcloud_server.this.ipv4_address
}

output "volume_id" {
  description = "Attached Volume ID, or null when volume_gb=0."
  value       = one(hcloud_volume.this[*].id)
}
