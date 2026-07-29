variable "cidr" {
  description = "Private network CIDR."
  type        = string
}

variable "subnet" {
  description = "Private subnet CIDR."
  type        = string
}

variable "zone" {
  description = "Hetzner network zone."
  type        = string
}
