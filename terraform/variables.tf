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
