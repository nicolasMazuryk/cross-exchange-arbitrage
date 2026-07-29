# Hetzner becomes authoritative for arbinet.xyz. NS delegation from GoDaddy is a
# one-time manual step (registrar-side); records below are fully Terraform-managed.
resource "hcloud_zone" "arbinet" {
  name = "arbinet.xyz"
  mode = "primary"
  ttl  = 3600
}

# query-api edge — A -> core box public IPv4 (kamal-proxy TLS host = api.arbinet.xyz)
resource "hcloud_zone_rrset" "api" {
  zone    = hcloud_zone.arbinet.id
  name    = "api"
  type    = "A"
  ttl     = 300
  records = [{ value = module.core.public_ipv4 }]
}

# apex A -> core box
resource "hcloud_zone_rrset" "root_a" {
  zone    = hcloud_zone.arbinet.id
  name    = "@"
  type    = "A"
  ttl     = 300
  records = [{ value = module.core.public_ipv4 }]
}

# www -> apex
resource "hcloud_zone_rrset" "www" {
  zone    = hcloud_zone.arbinet.id
  name    = "www"
  type    = "CNAME"
  ttl     = 3600
  records = [{ value = "arbinet.xyz." }]
}
