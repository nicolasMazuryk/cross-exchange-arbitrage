output "id" {
  description = "Firewall ID consumed by the host module."
  value       = hcloud_firewall.this.id
}
