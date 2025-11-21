variable "aws_region" {
  type        = string
  default     = "eu-central-1"
  description = "AWS region where resources will be created"
}

variable "aws_account_id" {
  type        = string
  default     = "846941037195"
  description = "AWS account ID"
}

variable "slack_webhook_url" {
  type        = string
  default     = "https://hooks.slack.com/services/REDACTED"
  description = "Slack webhook URL for notifications"
}

variable "app_instance_type" {
  type        = string
  default     = "c8g.large"
  description = "EC2 instance type for Application instance (ARM64 compatible). c8g.large provides 4GB RAM and 2 vCPUs suitable for Application instance"
  # or just c6g.large, c7g.large or even c8g.large - without Networking optimization, cheaper.
}

variable "redis_instance_type" {
  type        = string
  default     = "t4g.micro"
  description = "EC2 instance type for Redis server (ARM64 compatible). t4g.micro provides 1GB RAM and 2 vCPUs (burstable) suitable for Redis cache"
}