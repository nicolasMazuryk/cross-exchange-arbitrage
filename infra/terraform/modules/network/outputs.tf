output "id" {
  description = "Network ID consumed by the host module."
  # Reference the subnet's network_id (same value) so servers attaching via the
  # inline network block depend on the subnet existing first — avoids the
  # "no subnet available for server" race.
  value = hcloud_network_subnet.main.network_id
}
