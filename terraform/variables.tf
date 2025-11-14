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

variable "ec2_instance_type" {
  type        = string
  default     = "c6gn.large"
  description = "EC2 instance type for ECS cluster (ARM64 compatible). Recommended: c(7-8)gn.(x)large for HFT workloads with many websockets. Monitor and upgrade to c7gn.xlarge or even c8gn.xlarge if network metrics are consistently high."
  # or just c6g.large, c7g.large or even c8g.large - without Networking optimization, cheaper.
}
