###############################################################################
# EC2 Instance Outputs
###############################################################################
output "app_instances" {
  description = "Map of bot names to their instance details"
  value = {
    for key, instance in aws_instance.app_instances : key => {
      instance_id = instance.id
      private_ip  = instance.private_ip
      public_ip   = aws_eip.app_instance_eips[key].public_ip
    }
  }
}

output "redis_instance" {
  description = "Redis instance details"
  value = {
    instance_id = aws_instance.redis_instance.id
    private_ip  = aws_instance.redis_instance.private_ip
    public_ip   = aws_instance.redis_instance.public_ip
  }
}

output "redis_connection_url" {
  description = "Redis connection URL for the Application"
  value       = {
    connection_url = "redis://${aws_instance.redis_instance.private_ip}:6379"
  }
}

###############################################################################
# ECR Repository Outputs
###############################################################################
# output "ecr_repositories" {
#   description = "Map of ECR repository names to their URLs"
#   value = {
#     for key, repo in aws_ecr_repository.repositories : key => repo.repository_url
#   }
# }

###############################################################################
# CloudWatch Log Groups
###############################################################################
# output "bot_log_groups" {
#   description = "CloudWatch log groups for each bot"
#   value = {
#     for key, log_group in aws_cloudwatch_log_group.bot_log_groups : key => log_group.name
#   }
# }

# output "redis_log_group" {
#   description = "CloudWatch log group for Redis instance"
#   value       = aws_cloudwatch_log_group.redis_log_group.name
# }

###############################################################################
# SNS and Lambda Outputs
###############################################################################
# output "sns_topic_arn" {
#   description = "ARN of the SNS topic for alarms"
#   value       = aws_sns_topic.trading_bot_resource_utilization_alarms.arn
# }

# output "lambda_function_name" {
#   description = "Name of the Lambda function for Slack notifications"
#   value       = aws_lambda_function.sns_to_slack_notification.function_name
# }

###############################################################################
# Connection Instructions
###############################################################################
output "connection_instructions" {
  description = "Instructions for connecting to instances"
  value       = <<-EOT
    ========================================
    Quick Reference
    ========================================
    # View all bot instances
    terraform output app_instances
    
    # SSH to Redis instance
    ssh -i ~/.ssh/nicolas ec2-user@${aws_instance.redis_instance.public_ip}  # redis

    # SSH to specific bot
    %{for bot_name in keys(aws_instance.app_instances)~}
    ssh -i ~/.ssh/nicolas ec2-user@${aws_eip.app_instance_eips[bot_name].public_ip}  # ${bot_name}
    %{endfor~}
    ========================================
  EOT
}
