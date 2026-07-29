provider "hcloud" {
  token = var.hcloud_token
}

# AWS S3 provider pointed at the Hetzner Object Storage endpoint — hcloud has no
# bucket resource. Same endpoint/creds as the S3 tfstate backend (backend.tf);
# creds come from AWS_ACCESS_KEY_ID/AWS_SECRET_ACCESS_KEY env, never in TF.
provider "aws" {
  alias  = "hetzner_os"
  region = "nbg1"

  endpoints {
    s3 = "https://nbg1.your-objectstorage.com"
  }

  skip_credentials_validation = true
  skip_region_validation      = true
  skip_requesting_account_id  = true
  s3_use_path_style           = true
}

resource "aws_s3_bucket" "cold" {
  provider = aws.hetzner_os
  bucket   = "arbinet-cold"
}

resource "hcloud_ssh_key" "operator" {
  name       = "operator"
  public_key = var.operator_ssh_pubkey
}

module "network" {
  source = "./modules/network"
  cidr   = var.network_cidr
  subnet = var.subnet_cidr
  zone   = var.network_zone
}

module "fw_hot" {
  source       = "./modules/firewall"
  role         = "hot"
  operator_ips = var.operator_ips
}

module "fw_core" {
  source       = "./modules/firewall"
  role         = "core"
  operator_ips = var.operator_ips
}

module "fw_obs" {
  source       = "./modules/firewall"
  role         = "obs"
  operator_ips = var.operator_ips
}

module "hot" {
  source       = "./modules/host"
  name         = "hot"
  sku          = var.hot_sku
  image        = var.image
  location     = var.location
  private_ip   = "10.0.1.10"
  volume_gb    = 0
  network_id   = module.network.id
  firewall_ids = [module.fw_hot.id]
  labels       = { role = "hot", env = "prod" }
  ssh_keys            = [hcloud_ssh_key.operator.id]
  operator_ssh_pubkey = var.operator_ssh_pubkey
}

module "core" {
  source       = "./modules/host"
  name         = "core"
  sku          = var.core_sku
  image        = var.image
  location     = var.location
  private_ip   = "10.0.1.20"
  volume_gb    = 200
  volume_name  = "ch-volume"
  network_id   = module.network.id
  firewall_ids = [module.fw_core.id]
  labels       = { role = "core", env = "prod" }
  ssh_keys            = [hcloud_ssh_key.operator.id]
  operator_ssh_pubkey = var.operator_ssh_pubkey
}

module "obs" {
  source       = "./modules/host"
  name         = "obs"
  sku          = var.obs_sku
  image        = var.image
  location     = var.location
  private_ip   = "10.0.1.30"
  volume_gb    = 40
  network_id   = module.network.id
  firewall_ids = [module.fw_obs.id]
  labels       = { role = "obs", env = "prod" }
  ssh_keys            = [hcloud_ssh_key.operator.id]
  operator_ssh_pubkey = var.operator_ssh_pubkey
}
