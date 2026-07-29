output "hot_private_ip" {
  description = "Private IP of the hot box (trader)."
  value       = module.hot.private_ip
}

output "core_private_ip" {
  description = "Private IP of the core box."
  value       = module.core.private_ip
}

output "obs_private_ip" {
  description = "Private IP of the obs box."
  value       = module.obs.private_ip
}

output "tfstate_bucket" {
  description = "Object Storage bucket holding Terraform remote state."
  value       = "arbinet-tfstate"
}

output "cold_bucket" {
  description = "Object Storage bucket for CH cold disk + Parquet export."
  value       = "arbinet-cold"
}

output "zone_nameservers" {
  description = "Hetzner authoritative NS for arbinet.xyz — set these at the GoDaddy registrar."
  value       = hcloud_zone.arbinet.authoritative_nameservers.assigned
}

output "query_api_fqdn" {
  description = "Public FQDN of the query-api edge."
  value       = "api.arbinet.xyz"
}

output "core_public_ipv4" {
  description = "Core box public IPv4 (DNS A-record target / kamal-proxy edge)."
  value       = module.core.public_ipv4
}
