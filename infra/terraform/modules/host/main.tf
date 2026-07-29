resource "hcloud_server" "this" {
  name         = var.name
  server_type  = var.sku
  image        = var.image
  location     = var.location
  labels       = var.labels
  ssh_keys     = var.ssh_keys
  firewall_ids = [for id in var.firewall_ids : tonumber(id)]

  user_data = templatefile("${path.module}/cloud-init.yaml.tftpl", {
    ssh_pubkey    = var.operator_ssh_pubkey
    private_iface = var.private_iface
  })

  public_net {
    ipv4_enabled = true
    ipv6_enabled = true
  }

  # Attach to the private network at a fixed IP when requested.
  # The attach decision is gated on `attach_network` (known at plan time) rather
  # than on `network_id` itself: a computed/unknown network_id (fresh from-zero
  # apply, network created in the same run) makes the ternary's condition unknown,
  # so the for_each collection is unknown, and the hcloud provider's
  # validateUniqueNetworkIDs CustomizeDiff panics calling ElementIterator on it.
  dynamic "network" {
    for_each = var.attach_network ? toset(["primary"]) : toset([])
    content {
      network_id = tonumber(var.network_id)
      ip         = var.private_ip
    }
  }
}

resource "hcloud_volume" "this" {
  count = var.volume_gb > 0 ? 1 : 0

  name     = coalesce(var.volume_name, "${var.name}-data")
  size     = var.volume_gb
  location = var.location
  format   = "ext4"
  labels   = var.labels
}

resource "hcloud_volume_attachment" "this" {
  count = var.volume_gb > 0 ? 1 : 0

  volume_id = hcloud_volume.this[0].id
  server_id = hcloud_server.this.id
  automount = true
}
