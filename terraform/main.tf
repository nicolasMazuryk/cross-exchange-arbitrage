###############################################################################
# Provider Configuration
###############################################################################
terraform {
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 6.12.0" # Use version constraint for flexibility // 5.82.2
    }
  }
  required_version = "~> 1.13.5" # Use version constraint for flexibility
}

locals {
  # Common tags to be applied to all resources
  common_tags = {
    Project   = "arbitrage-bots"
    ManagedBy = "terraform"
  }

  # Bot configurations
  bots = {
    funding_arbitrage_bot = {
      cpu      = 1024
      memory   = 2048
      strategy = "FUNDING"
      log_level = "INFO"
    }
    # spread_arbitrage_bot = {
    #   cpu      = 1024
    #   memory   = 2048
    #   strategy = "SPREAD"
    #   log_level = "INFO"
    # }
  }
}

provider "aws" {
  region = var.aws_region

  default_tags {
    tags = local.common_tags
  }
}

###############################################################################
# Default VPC & Subnets
###############################################################################
resource "aws_default_vpc" "default" {
  tags = {
    Name = "default"
  }
}

resource "aws_default_subnet" "default_a" {
  availability_zone = "${var.aws_region}a"

  tags = {
    Name = "default-a"
  }
}

###############################################################################
# Security Group for Fargate Tasks
# - Outbound allowed by default
# - Inbound restricted (since you probably only need outbound to exchanges)
###############################################################################
resource "aws_security_group" "trading_bot_security_group" {
  name        = "trading-bot-security-group"
  description = "Security group for trading bot Fargate tasks"
  vpc_id      = aws_default_vpc.default.id

  # No inbound rules needed if you don't accept inbound traffic
  ingress {
    description = "No inbound traffic"
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["127.0.0.1/32"] # effectively block inbound
  }

  egress {
    description = "Allow all outbound"
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = {
    Name = "trading-bot-security-group"
  }
}

###############################################################################
# ECS Cluster
###############################################################################
resource "aws_ecs_cluster" "trading_bots_cluster" {
  name = "trading-bots-cluster"

  setting {
    name  = "containerInsights"
    value = "enabled"
  }
}

###############################################################################
# ECS Task IAM Role
###############################################################################
resource "aws_iam_role" "ecs_task_execution_role" {
  name               = "trading-bot-execution-role"
  assume_role_policy = data.aws_iam_policy_document.ecs_task_execution_role.json
}

data "aws_iam_policy_document" "ecs_task_execution_role" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["ecs-tasks.amazonaws.com"]
    }
  }
}

resource "aws_iam_role_policy_attachment" "ecs_task_execution_policy" {
  role       = aws_iam_role.ecs_task_execution_role.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy"
}

resource "aws_iam_role" "ecs_task_role" {
  name               = "trading-bot-task-role"
  assume_role_policy = data.aws_iam_policy_document.ecs_task_role.json
}

data "aws_iam_policy_document" "ecs_task_role" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["ecs-tasks.amazonaws.com"]
    }
  }
}

###############################################################################
# CloudWatch Log Groups
###############################################################################
resource "aws_cloudwatch_log_group" "log_groups" {
  for_each          = local.bots
  name              = "/ecs/${each.key}"
  retention_in_days = 14
}

###############################################################################
# CloudWatch Errors to Lambda
###############################################################################
# Temporarily disabled - comment out to re-enable error notifications
# resource "aws_lambda_permission" "cloudwatch_errors_to_lambda_permissions" {
#   for_each      = local.bots
#   statement_id  = "AllowExecutionFromCloudWatch_${each.key}"
#   action        = "lambda:InvokeFunction"
#   function_name = "cloud-watch-errors-slack-notifications-lambda"
#   principal     = "logs.${var.aws_region}.amazonaws.com"
#   source_arn    = "${aws_cloudwatch_log_group.log_groups[each.key].arn}:*"
# }

# resource "aws_cloudwatch_log_subscription_filter" "cloudwatch_errors_subscription_filters" {
#   for_each        = local.bots
#   name            = "${each.key}-error-subscription-filter"
#   log_group_name  = aws_cloudwatch_log_group.log_groups[each.key].name
#   filter_pattern  = "?ERROR ?Error ?error"
#   destination_arn = "arn:aws:lambda:${var.aws_region}:${var.aws_account_id}:function:cloud-watch-errors-slack-notifications-lambda"
# }

###############################################################################
# ECR Repositories
###############################################################################
resource "aws_ecr_repository" "repositories" {
  for_each = local.bots
  name     = each.key
}

###############################################################################
# ECS Task Definitions
###############################################################################
resource "aws_ecs_task_definition" "task_definitions" {
  for_each                 = local.bots
  family                   = each.key
  network_mode             = "awsvpc"
  requires_compatibilities = ["FARGATE"]
  cpu                      = each.value.cpu
  memory                   = each.value.memory
  execution_role_arn       = aws_iam_role.ecs_task_execution_role.arn
  task_role_arn            = aws_iam_role.ecs_task_role.arn

  runtime_platform {
    operating_system_family = "LINUX"
    cpu_architecture       = "ARM64"
  }

  container_definitions = jsonencode([
    {
      name      = each.key
      image     = "${aws_ecr_repository.repositories[each.key].repository_url}:latest"
      essential = true
      environment = [
        # {
        #   name  = "LOG_LEVEL"
        #   value = each.value.log_level
        # },
        # {
        #   name  = "STRATEGY"
        #   value = each.value.strategy
        # }
      ]
      logConfiguration = {
        logDriver = "awslogs"
        options = {
          awslogs-group         = aws_cloudwatch_log_group.log_groups[each.key].name
          awslogs-region        = var.aws_region
          awslogs-stream-prefix = "ecs"
        }
      }
    }
  ])
}

###############################################################################
# ECS Services (one per bot), each uses FARGATE
# - desired_count = 1 ensures each bot runs exactly one instance
###############################################################################
resource "aws_ecs_service" "services" {
  for_each        = local.bots
  name            = "${each.key}-service"
  cluster         = aws_ecs_cluster.trading_bots_cluster.id
  task_definition = aws_ecs_task_definition.task_definitions[each.key].arn
  desired_count   = 1
  launch_type     = "FARGATE"

  network_configuration {
    subnets          = [aws_default_subnet.default_a.id]
    security_groups  = [aws_security_group.trading_bot_security_group.id]
    assign_public_ip = true
  }

  deployment_controller {
    type = "ECS"
  }
}


###############################################################################
# SNS to Slack Notifier Lambda
###############################################################################
resource "aws_lambda_function" "sns_to_slack_notification" {
  s3_bucket         = "algo-trading-bot"
  s3_key            = "lambdas/sns_to_slack_notification.zip"
  function_name    = "sns-to-slack-notification"
  role             = aws_iam_role.sns_to_slack_notification_lambda_role.arn
  handler          = "index.handler"
  runtime          = "nodejs18.x"

  environment {
    variables = {
      SLACK_WEBHOOK_URL = var.slack_webhook_url
    }
  }
}

resource "aws_iam_role" "sns_to_slack_notification_lambda_role" {
  name = "sns-to-slack-notification-lambda-role"
  description = "IAM role for Lambda function that forwards SNS messages to Slack"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Action = "sts:AssumeRole"
        Effect = "Allow"
        Principal = {
          Service = "lambda.amazonaws.com"
        }
      }
    ]
  })
}

resource "aws_iam_role_policy" "sns_to_slack_lambda_cloudwatch_logging_policy" {
  name = "sns-to-slack-notification-lambda-cloudwatch-logging-policy"
  role = aws_iam_role.sns_to_slack_notification_lambda_role.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect = "Allow"
        Action = [
          "logs:CreateLogGroup",
          "logs:CreateLogStream", 
          "logs:PutLogEvents"
        ]
        Resource = "arn:aws:logs:${var.aws_region}:${var.aws_account_id}:*"
      }
    ]
  })
}

resource "aws_lambda_permission" "sns_to_slack_notification_lambda_permission" {
  statement_id  = "AllowExecutionFromSNS"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.sns_to_slack_notification.function_name
  principal     = "sns.amazonaws.com"
  source_arn    = aws_sns_topic.trading_bot_resource_utilization_alarms.arn
}

###############################################################################
# SNS Topic for Resource Utilization Alarms
###############################################################################
resource "aws_sns_topic" "trading_bot_resource_utilization_alarms" {
  name = "trading-bot-resource-utilization-alarms"
}

resource "aws_sns_topic_subscription" "lambda_slack_subscription" {
  topic_arn = aws_sns_topic.trading_bot_resource_utilization_alarms.arn
  protocol  = "lambda"
  endpoint  = aws_lambda_function.sns_to_slack_notification.arn
}

###############################################################################
# CloudWatch Alarms for CPU and Memory Utilization
###############################################################################
resource "aws_cloudwatch_metric_alarm" "cpu_alarms" {
  for_each            = local.bots
  alarm_name          = "${each.key}-cpu-alarm"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 2
  metric_name         = "CPUUtilization"
  namespace           = "AWS/ECS"
  period              = 10 # 10 seconds
  statistic           = "Average"
  threshold           = 70 # 70% CPU utilization
  alarm_description   = "CPU utilization is too high for ${each.key}"

  dimensions = {
    ClusterName = aws_ecs_cluster.trading_bots_cluster.name
    ServiceName = aws_ecs_service.services[each.key].name
  }

  alarm_actions = [aws_sns_topic.trading_bot_resource_utilization_alarms.arn]
  ok_actions    = [aws_sns_topic.trading_bot_resource_utilization_alarms.arn]

  tags = {
    Service = each.key
  }
}

resource "aws_cloudwatch_metric_alarm" "memory_alarms" {
  for_each            = local.bots
  alarm_name          = "${each.key}-memory-alarm"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 2
  metric_name         = "MemoryUtilization"
  namespace           = "AWS/ECS"
  period              = 10 # 10 seconds
  statistic           = "Average"
  threshold           = 70 # 70% memory utilization
  alarm_description   = "Memory utilization is too high for ${each.key}"

  dimensions = {
    ClusterName = aws_ecs_cluster.trading_bots_cluster.name
    ServiceName = aws_ecs_service.services[each.key].name
  }

  alarm_actions = [aws_sns_topic.trading_bot_resource_utilization_alarms.arn]
  ok_actions    = [aws_sns_topic.trading_bot_resource_utilization_alarms.arn]

  tags = {
    Service = each.key
  }
}

###############################################################################
# IAM Policy for CloudWatch Metrics
###############################################################################
resource "aws_iam_policy" "cloudwatch_metrics_policy" {
  name        = "CloudWatchMetricsPolicy"
  description = "Allows CloudWatch to publish metrics for ECS trading bots."

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect = "Allow"
        Action = [
          "cloudwatch:PutMetricData",
          "cloudwatch:GetMetricStatistics", 
          "cloudwatch:GetMetricData",
          "cloudwatch:ListMetrics",
          "cloudwatch:DescribeAlarms",
          "cloudwatch:DescribeAlarmsForMetric",
          "cloudwatch:DescribeAlarmHistory"
        ]
        Resource = "arn:aws:cloudwatch:${var.aws_region}:${var.aws_account_id}:*"
      },
      {
        Effect = "Allow"
        Action = [
          "logs:CreateLogStream",
          "logs:PutLogEvents",
          "logs:DescribeLogStreams"
        ]
        Resource = [for log_group in aws_cloudwatch_log_group.log_groups : "${log_group.arn}:*"]
      }
    ]
  })
}

resource "aws_iam_role_policy_attachment" "attach_cloudwatch_metrics_policy" {
  role       = aws_iam_role.ecs_task_execution_role.name
  policy_arn = aws_iam_policy.cloudwatch_metrics_policy.arn
}
