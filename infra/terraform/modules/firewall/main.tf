# Role-keyed inbound rule sets. hcloud firewalls filter inbound only
# (outbound is default-allow), matching the spec which lists only `in` rules.
locals {
  # Common to all three roles: operator SSH + WireGuard, plus private-net
  # all-allow (hcloud has no single "all protocols" rule — tcp-any + udp-any +
  # icmp is the idiomatic equivalent and covers every private flow the spec names).
  common_rules = [
    {
      direction  = "in"
      protocol   = "tcp"
      port       = "22"
      source_ips = var.operator_ips
    },
    {
      direction  = "in"
      protocol   = "udp"
      port       = "51820"
      source_ips = var.operator_ips
    },
    {
      direction  = "in"
      protocol   = "tcp"
      port       = "any"
      source_ips = [var.private_cidr]
    },
    {
      direction  = "in"
      protocol   = "udp"
      port       = "any"
      source_ips = [var.private_cidr]
    },
    {
      direction  = "in"
      protocol   = "icmp"
      port       = null
      source_ips = [var.private_cidr]
    },
  ]

  # core is the only public edge: 80/443 → kamal-proxy TLS. hot/obs expose no
  # public service ports.
  public_edge_rules = [
    {
      direction  = "in"
      protocol   = "tcp"
      port       = "80"
      source_ips = ["0.0.0.0/0", "::/0"]
    },
    {
      direction  = "in"
      protocol   = "tcp"
      port       = "443"
      source_ips = ["0.0.0.0/0", "::/0"]
    },
  ]

  rules = concat(local.common_rules, var.role == "core" ? local.public_edge_rules : [])
}

resource "hcloud_firewall" "this" {
  name = "fw-${var.role}"

  dynamic "rule" {
    for_each = local.rules
    content {
      direction  = rule.value.direction
      protocol   = rule.value.protocol
      port       = rule.value.port
      source_ips = rule.value.source_ips
    }
  }
}
