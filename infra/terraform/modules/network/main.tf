resource "hcloud_network" "prod_vpc" {
  name     = "prod-vpc"
  ip_range = var.cidr
}

resource "hcloud_network_subnet" "main" {
  network_id   = hcloud_network.prod_vpc.id
  type         = "cloud"
  network_zone = var.zone
  ip_range     = var.subnet
}
