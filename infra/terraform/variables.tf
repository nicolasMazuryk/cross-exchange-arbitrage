variable "hcloud_token" {
  description = "Hetzner Cloud API token; supplied via TF_VAR_hcloud_token, never defaulted."
  type        = string
  sensitive   = true
}

variable "operator_ips" {
  description = "Operator source IPs allowed on SSH/WireGuard firewall rules."
  type        = list(string)
  default     = ["OPERATOR_IP"]
}

variable "operator_ssh_pubkey" {
  description = "Operator ed25519 public key — feeds the hcloud_ssh_key resource and cloud-init authorized_keys (single source, no drift)."
  type        = string
  default     = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAICIljEw49E8vw0nrc6zzdsooLDFAsE5HSs/AxMspZiY5 nicolasmazuryk@gmail.com"
}

variable "location" {
  description = "Hetzner datacenter location."
  type        = string
  default     = "nbg1"
}

variable "network_zone" {
  description = "Hetzner network zone for the private network."
  type        = string
  default     = "eu-central"
}

variable "image" {
  description = "Server base image."
  type        = string
  default     = "ubuntu-24.04"
}

variable "network_cidr" {
  description = "Private network CIDR."
  type        = string
  default     = "10.0.0.0/16"
}

variable "subnet_cidr" {
  description = "Private subnet CIDR."
  type        = string
  default     = "10.0.1.0/24"
}

variable "hot_sku" {
  description = "Server type for the hot box (trader)."
  type        = string
  default     = "ccx13"
}

variable "core_sku" {
  description = "Server type for the core box (ClickHouse + Redpanda + query-api + kamal-proxy)."
  type        = string
  # cpx51 (prior gen) is EOL — no longer orderable in nbg1. cpx62 is the x2-gen
  # successor with identical 16 cores / 32 GB RAM.
  default = "cpx62"
}

variable "obs_sku" {
  description = "Server type for the obs box (observability stack)."
  type        = string
  # cpx41 (prior gen) is EOL — no longer orderable in nbg1. cpx42 is the x2-gen
  # successor with identical 8 cores / 16 GB RAM.
  default = "cpx42"
}
