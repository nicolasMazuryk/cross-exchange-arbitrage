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

  # Instance type memory lookup (in MB) - leaving ~512MB for OS overhead
  instance_memory = {
    "c6gn.large"   = 3584  # 4 GiB - 512MB overhead
    "c6gn.xlarge"  = 7680  # 8 GiB - 512MB overhead
    "c7gn.large"  = 3584  # 4 GiB - 512MB overhead
    "c7gn.xlarge" = 7680  # 8 GiB - 512MB overhead
    "c8gn.large"  = 3584  # 4 GiB - 512MB overhead
    "c8gn.xlarge" = 7680  # 8 GiB - 512MB overhead
  }

  # Calculate container memory reservation based on instance type
  container_memory_reservation = lookup(local.instance_memory, var.ec2_instance_type)

  # Bot configurations
  bots = {
    funding_arbitrage_bot = {
      # cpu      = 1024
      # memory   = 2048
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
  availability_zone       = "${var.aws_region}a"
  # Note: assign_public_ip is only for Fargate. For EC2 launch type,
  # tasks get public IPs automatically if subnet has map_public_ip_on_launch = true
  map_public_ip_on_launch = true # Required for ECS tasks to get public IPs and reach internet

  tags = {
    Name = "default-a"
  }
}

resource "aws_default_subnet" "default_b" {
  availability_zone = "${var.aws_region}b"

  tags = {
    Name = "default-b"
  }
}

resource "aws_default_subnet" "default_c" {
  availability_zone = "${var.aws_region}c"

  tags = {
    Name = "default-c"
  }
}

###############################################################################
# Security Group for ECS Tasks (EC2)
# - Outbound allowed by default
# - Inbound restricted (since you probably only need outbound to exchanges)
###############################################################################
resource "aws_security_group" "trading_bots_security_group" {
  name        = "trading-bots-security-group"
  description = "Security group for trading bot ECS tasks on EC2"
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
    Name = "trading-bots-security-group"
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
# IAM Role for EC2 Instances (ECS Container Instance Role)
###############################################################################
resource "aws_iam_role" "ecs_instance_role" {
  name               = "trading-bot-ec2-instance-role"
  assume_role_policy = data.aws_iam_policy_document.ecs_instance_role.json
}

data "aws_iam_policy_document" "ecs_instance_role" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["ec2.amazonaws.com"]
    }
  }
}

resource "aws_iam_role_policy_attachment" "ecs_instance_role_policy" {
  role       = aws_iam_role.ecs_instance_role.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonEC2ContainerServiceforEC2Role"
}

resource "aws_iam_instance_profile" "ecs_instance_profile" {
  name = "trading-bot-ec2-instance-profile"
  role = aws_iam_role.ecs_instance_role.name
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
  requires_compatibilities = ["EC2"]
  # Note: CPU and memory are optional for EC2 but help with resource reservation
  # cpu                = each.value.cpu
  # memory             = each.value.memory
  execution_role_arn = aws_iam_role.ecs_task_execution_role.arn
  task_role_arn      = aws_iam_role.ecs_task_role.arn

  runtime_platform {
    operating_system_family = "LINUX"
    cpu_architecture       = "ARM64"
    # cpu_architecture       = "X86_64"
  }

  container_definitions = jsonencode([
    {
      name                = each.key
      image               = "${aws_ecr_repository.repositories[each.key].repository_url}:latest"
      essential           = true
      memoryReservation   = local.container_memory_reservation
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
# ECS Services (one per bot), each uses EC2
# - desired_count = 1 ensures each bot runs exactly one instance
###############################################################################
resource "aws_ecs_service" "services" {
  for_each        = local.bots
  name            = "${each.key}-service"
  cluster         = aws_ecs_cluster.trading_bots_cluster.id
  task_definition = aws_ecs_task_definition.task_definitions[each.key].arn
  desired_count   = 1
  launch_type     = "EC2"

  network_configuration {
    subnets         = [aws_default_subnet.default_a.id]
    security_groups = [aws_security_group.trading_bots_security_group.id]
    # For EC2 launch type, tasks get public IPs automatically if subnet has map_public_ip_on_launch = true
  }

  deployment_controller {
    type = "ECS"
  }

  depends_on = [
    aws_instance.ecs_instance
  ]
}

###############################################################################
# Data source for ECS-optimized AMI
###############################################################################
data "aws_ami" "ecs_optimized" {
  most_recent = true
  owners      = ["amazon"]

  filter {
    name   = "name"
    values = ["al2023-ami-ecs-hvm-*-arm64*"]
    # values = ["al2023-ami-ecs-hvm-*-x86_64*"] 
  }

  filter {
    name   = "virtualization-type"
    values = ["hvm"]
  }

  filter {
    name   = "architecture"
    values = ["arm64"]
    # values = ["x86_64"]
  }
}

###############################################################################
# Internet Gateway (default VPC should have one, but we'll reference it)
###############################################################################
data "aws_internet_gateway" "default" {
  filter {
    name   = "attachment.vpc-id"
    values = [aws_default_vpc.default.id]
  }
}

###############################################################################
# NAT Gateway for ECS Tasks Internet Access
# Required because EC2 launch type with awsvpc doesn't auto-assign public IPs to task ENIs
###############################################################################
resource "aws_eip" "nat_gateway_eip" {
  domain = "vpc"

  tags = merge(
    local.common_tags,
    {
      Name = "trading-bot-nat-gateway-eip"
    }
  )
}

resource "aws_nat_gateway" "trading_bots_nat" {
  allocation_id = aws_eip.nat_gateway_eip.id
  subnet_id     = aws_default_subnet.default_a.id

  tags = merge(
    local.common_tags,
    {
      Name = "trading-bot-nat-gateway"
    }
  )

  depends_on = [data.aws_internet_gateway.default]
}

###############################################################################
# Route Table for ECS Tasks (routes through NAT Gateway)
###############################################################################
resource "aws_route_table" "ecs_tasks_route_table" {
  vpc_id = aws_default_vpc.default.id

  route {
    cidr_block     = "0.0.0.0/0"
    nat_gateway_id = aws_nat_gateway.trading_bots_nat.id
  }

  tags = merge(
    local.common_tags,
    {
      Name = "trading-bot-ecs-tasks-route-table"
    }
  )
}

###############################################################################
# Route Table Association for Subnet A (where ECS tasks run)
###############################################################################
resource "aws_route_table_association" "ecs_tasks_subnet_a" {
  subnet_id      = aws_default_subnet.default_a.id
  route_table_id = aws_route_table.ecs_tasks_route_table.id
}

###############################################################################
# Elastic IP for ECS Instance
###############################################################################
resource "aws_eip" "ecs_instance_eip" {
  domain = "vpc"

  tags = merge(
    local.common_tags,
    {
      Name = "trading-bot-ecs-instance-eip"
    }
  )
}

###############################################################################
# EC2 Instance for ECS (standalone - no Auto Scaling Group)
# Single instance managed directly by Terraform
###############################################################################
resource "aws_instance" "ecs_instance" {
  ami                    = data.aws_ami.ecs_optimized.id
  instance_type          = var.ec2_instance_type
  subnet_id              = aws_default_subnet.default_a.id
  vpc_security_group_ids = [aws_security_group.trading_bots_security_group.id]
  iam_instance_profile   = aws_iam_instance_profile.ecs_instance_profile.name
  monitoring             = true # Enable detailed CloudWatch monitoring

  user_data = <<-EOT
    #!/bin/bash
    echo ECS_CLUSTER=${aws_ecs_cluster.trading_bots_cluster.name} >> /etc/ecs/ecs.config
  EOT

  metadata_options {
    http_endpoint               = "enabled"
    http_tokens                 = "required"
    http_put_response_hop_limit = 1
  }

  tags = merge(
    local.common_tags,
    {
      Name = "trading-bot-ecs-instance"
    }
  )
}

###############################################################################
# Elastic IP Association
###############################################################################
resource "aws_eip_association" "ecs_instance_eip_assoc" {
  instance_id   = aws_instance.ecs_instance.id
  allocation_id = aws_eip.ecs_instance_eip.id
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

###############################################################################
# ElastiCache Redis
###############################################################################
# Security Group for ElastiCache
resource "aws_security_group" "elasticache_security_group" {
  name        = "elasticache-security-group"
  description = "Allows access to ElastiCache from Bastion and ECS EC2 instances"
  vpc_id      = aws_default_vpc.default.id

  ingress {
    description     = "Allow Redis access from ECS EC2 tasks"
    from_port       = 6379
    to_port         = 6379
    protocol        = "tcp"
    security_groups = [aws_security_group.trading_bots_security_group.id]
  }

  ingress {
    description     = "Allow Redis access from Bastion"
    from_port       = 6379
    to_port         = 6379
    protocol        = "tcp"
    security_groups = [data.aws_security_group.bastion.id]
  }

  egress {
    description = "Allow all outbound"
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = {
    Name = "elasticache-security-group"
  }
}

# Data source to get the default security group
data "aws_security_group" "default" {
  name   = "default"
  vpc_id = aws_default_vpc.default.id
}

# Data source to get the bastion security group
data "aws_security_group" "bastion" {
  name   = "bastion"
  vpc_id = aws_default_vpc.default.id
}

# ElastiCache Subnet Group
resource "aws_elasticache_subnet_group" "trading_bots_cache_subnet" {
  name       = "trading-bots-cache-subnet"
  subnet_ids = [aws_default_subnet.default_a.id, aws_default_subnet.default_b.id, aws_default_subnet.default_c.id]

  tags = {
    Name        = "trading-bots-cache-subnet"
    Description = "Subnet for ElastiCache for trading-bots"
  }
}

# ElastiCache Replication Group (Redis)
resource "aws_elasticache_replication_group" "trading_bots_cache" {
  replication_group_id       = "trading-bots-cache"
  description                = "Redis for trading-bots"
  engine                     = "redis"
  engine_version             = "7.1"
  node_type                  = "cache.t4g.micro"
  port                       = 6379
  parameter_group_name       = "default.redis7"
  num_cache_clusters         = 2
  automatic_failover_enabled = true
  multi_az_enabled           = false
  at_rest_encryption_enabled = true
  transit_encryption_enabled = false # No TLS
  auto_minor_version_upgrade = true
  snapshot_retention_limit   = 0     # Automatic backups - Disabled (0 = no backups)

  subnet_group_name  = aws_elasticache_subnet_group.trading_bots_cache_subnet.name
  security_group_ids = [
    aws_security_group.elasticache_security_group.id,
    data.aws_security_group.default.id
  ]

  tags = {
    Name = "trading-bots-cache"
  }
}
