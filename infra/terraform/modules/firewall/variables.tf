variable "role" {
  description = "Firewall role: hot | core | obs — selects the rule set."
  type        = string
}

variable "operator_ips" {
  description = "Operator source IPs allowed on SSH/WireGuard rules."
  type        = list(string)
}

variable "private_cidr" {
  description = "Private subnet CIDR for the all-allow intra-net rules."
  type        = string
  default     = "10.0.1.0/24"
}
