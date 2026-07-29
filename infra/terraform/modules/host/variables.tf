variable "name" {
  description = "Server name."
  type        = string
}

variable "sku" {
  description = "Hetzner server type."
  type        = string
}

variable "image" {
  description = "Server base image."
  type        = string
}

variable "location" {
  description = "Hetzner datacenter location."
  type        = string
}

variable "private_ip" {
  description = "Static private IP on the subnet."
  type        = string
}

variable "volume_gb" {
  description = "Attached Volume size in GB; 0 means no Volume."
  type        = number
}

variable "volume_name" {
  description = "Override the volume name; defaults to <name>-data."
  type        = string
  default     = null
}

variable "network_id" {
  description = "Private network ID to attach to."
  type        = string
  nullable    = true
}

variable "attach_network" {
  description = "Whether to attach the host to the private network. Decoupled from network_id so the attach decision stays known at plan time even when network_id is computed (avoids the hcloud provider unknown-for_each CustomizeDiff panic)."
  type        = bool
  default     = true
}

variable "firewall_ids" {
  description = "Firewall IDs to attach."
  type        = list(string)
}

variable "labels" {
  description = "Resource labels (role/env) for Ansible dynamic inventory."
  type        = map(string)
}

variable "ssh_keys" {
  description = "hcloud_ssh_key IDs injected at creation."
  type        = list(string)
}

variable "operator_ssh_pubkey" {
  description = "Operator ed25519 public key for cloud-init authorized_keys."
  type        = string
}

variable "private_iface" {
  description = "Predictable name of the Hetzner private NIC (2nd NIC = PCI slot 7 => enp7s0 on current SKUs). Threaded into cloud-init for the NIC bring-up backstop; override only if a future image enumerates differently."
  type        = string
  default     = "enp7s0"
}
