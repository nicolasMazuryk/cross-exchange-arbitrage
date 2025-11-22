###############################################################################
# Provider Configuration
###############################################################################
terraform {
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 6.12.0"
    }
  }
  required_version = "~> 1.13.5"
}

locals {
  # Common tags to be applied to all resources
  common_tags = {
    Project   = "trading-bots"
    ManagedBy = "terraform"
  }

  # Bot configurations for ECR repositories and CloudWatch logs
  bots = {
    funding_arbitrage_bot = {
      strategy  = "FUNDING"
      log_level = "INFO"
    }
    # spread_arbitrage_bot = {
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
# VPC & Subnets
###############################################################################
# Using default VPC with public subnet for both instances
resource "aws_default_vpc" "default" {
  tags = {
    Name = "default"
  }
}

# Public subnet for both EC2 instances
resource "aws_default_subnet" "default_a" {
  availability_zone       = "${var.aws_region}a"
  map_public_ip_on_launch = true

  tags = {
    Name = "trading-bots-public-subnet"
  }
}

###############################################################################
# Internet Gateway
###############################################################################
data "aws_internet_gateway" "default" {
  filter {
    name   = "attachment.vpc-id"
    values = [aws_default_vpc.default.id]
  }
}

###############################################################################
# Security Groups
###############################################################################
# Security group for Redis instance
resource "aws_security_group" "redis_security_group" {
  name        = "trading-bots-redis-sg"
  description = "Security group for Redis EC2 instance"
  vpc_id      = aws_default_vpc.default.id

  # Allow Redis port from Application instance
  ingress {
    description     = "Redis from Application instance"
    from_port       = 6379
    to_port         = 6379
    protocol        = "tcp"
    security_groups = [aws_security_group.app_security_group.id]
  }

  # Allow Redis port (6379) from Bastion
  ingress {
    description     = "Redis from Bastion"
    from_port       = 6379
    to_port         = 6379
    protocol        = "tcp"
    security_groups = [data.aws_security_group.bastion.id]
  }

  # Allow SSH from anywhere for maintenance
  ingress {
    description = "SSH from anywhere"
    from_port   = 22
    to_port     = 22
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }

  egress {
    description = "Allow all outbound"
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = {
    Name = "trading-bots-redis-sg"
  }
}

# Security group for Application instance
resource "aws_security_group" "app_security_group" {
  name        = "trading-bots-app-sg"
  description = "Security group for Application EC2 instance"
  vpc_id      = aws_default_vpc.default.id

  # Allow SSH from anywhere for maintenance
  ingress {
    description = "SSH from anywhere"
    from_port   = 22
    to_port     = 22
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }

  egress {
    description = "Allow all outbound"
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = {
    Name = "trading-bots-app-sg"
  }
}

# Data source for bastion security group
data "aws_security_group" "bastion" {
  name   = "bastion"
  vpc_id = aws_default_vpc.default.id
}

###############################################################################
# IAM Roles for EC2 Instances
###############################################################################
# IAM role for Redis instance
resource "aws_iam_role" "redis_instance_role" {
  name               = "trading-bot-redis-instance-role"
  assume_role_policy = data.aws_iam_policy_document.ec2_assume_role.json
}

# IAM role for Application instance
resource "aws_iam_role" "app_instance_role" {
  name               = "trading-bot-app-instance-role"
  assume_role_policy = data.aws_iam_policy_document.ec2_assume_role.json
}

data "aws_iam_policy_document" "ec2_assume_role" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["ec2.amazonaws.com"]
    }
  }
}

# IAM instance profiles
resource "aws_iam_instance_profile" "redis_instance_profile" {
  name = "trading-bot-redis-instance-profile"
  role = aws_iam_role.redis_instance_role.name
}

resource "aws_iam_instance_profile" "app_instance_profile" {
  name = "trading-bot-app-instance-profile"
  role = aws_iam_role.app_instance_role.name
}

# CloudWatch Logs permissions for both instances
resource "aws_iam_policy" "cloudwatch_logs_policy" {
  name        = "trading-bot-cloudwatch-logs-policy"
  description = "Allows EC2 instances to write logs and metrics to CloudWatch"

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect = "Allow"
        Action = [
          "logs:CreateLogGroup",
          "logs:CreateLogStream",
          "logs:PutLogEvents",
          "logs:DescribeLogStreams"
        ]
        Resource = concat(
          [for log_group in aws_cloudwatch_log_group.bot_log_groups : "${log_group.arn}:*"],
          ["${aws_cloudwatch_log_group.redis_log_group.arn}:*"]
        )
      },
      {
        Effect = "Allow"
        Action = [
          "cloudwatch:PutMetricData",
          "cloudwatch:GetMetricStatistics",
          "cloudwatch:ListMetrics"
        ]
        Resource = "*"
      },
      {
        Effect = "Allow"
        Action = [
          "ec2:DescribeTags",
          "ec2:DescribeInstances"
        ]
        Resource = "*"
      }
    ]
  })
}

# Attach CloudWatch policy to both roles
resource "aws_iam_role_policy_attachment" "redis_cloudwatch_logs" {
  role       = aws_iam_role.redis_instance_role.name
  policy_arn = aws_iam_policy.cloudwatch_logs_policy.arn
}

resource "aws_iam_role_policy_attachment" "app_cloudwatch_logs" {
  role       = aws_iam_role.app_instance_role.name
  policy_arn = aws_iam_policy.cloudwatch_logs_policy.arn
}

# ECR permissions for Application instance
resource "aws_iam_policy" "ecr_pull_policy" {
  name        = "trading-bot-ecr-pull-policy"
  description = "Allows EC2 instance to pull images from ECR"

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect = "Allow"
        Action = [
          "ecr:GetAuthorizationToken",
          "ecr:BatchCheckLayerAvailability",
          "ecr:GetDownloadUrlForLayer",
          "ecr:BatchGetImage"
        ]
        Resource = "*"
      }
    ]
  })
}

resource "aws_iam_role_policy_attachment" "app_ecr_pull" {
  role       = aws_iam_role.app_instance_role.name
  policy_arn = aws_iam_policy.ecr_pull_policy.arn
}

resource "aws_iam_role_policy_attachment" "redis_ecr_pull" {
  role       = aws_iam_role.redis_instance_role.name
  policy_arn = aws_iam_policy.ecr_pull_policy.arn
}

###############################################################################
# CloudWatch Log Groups
###############################################################################
# Log group for Redis instance
resource "aws_cloudwatch_log_group" "redis_log_group" {
  name              = "/ec2/trading-bots/redis"
  retention_in_days = 14

  tags = {
    Name = "trading-bots-redis-logs"
  }
}

# Log groups for each bot application
resource "aws_cloudwatch_log_group" "bot_log_groups" {
  for_each          = local.bots
  name              = "/ec2/trading-bots/${each.key}"
  retention_in_days = 14

  tags = {
    Name = "${each.key}-logs"
  }
}

###############################################################################
# CloudWatch Errors to Lambda
###############################################################################
# Lambda permissions for each bot's log group
resource "aws_lambda_permission" "cloudwatch_errors_to_lambda_bots" {
  for_each      = local.bots
  statement_id  = "AllowExecutionFromCloudWatch_${each.key}"
  action        = "lambda:InvokeFunction"
  function_name = "cloud-watch-errors-slack-notifications-lambda"
  principal     = "logs.${var.aws_region}.amazonaws.com"
  source_arn    = "${aws_cloudwatch_log_group.bot_log_groups[each.key].arn}:*"
}

# Error subscription filters for each bot's log group
resource "aws_cloudwatch_log_subscription_filter" "bot_errors_filters" {
  for_each        = local.bots
  name            = "${each.key}-error-subscription-filter"
  log_group_name  = aws_cloudwatch_log_group.bot_log_groups[each.key].name
  filter_pattern  = "?ERROR ?Error ?error"
  destination_arn = "arn:aws:lambda:${var.aws_region}:${var.aws_account_id}:function:cloud-watch-errors-slack-notifications-lambda"

  depends_on = [aws_lambda_permission.cloudwatch_errors_to_lambda_bots]
}

###############################################################################
# ECR Repositories
###############################################################################
resource "aws_ecr_repository" "repositories" {
  for_each     = local.bots
  name         = each.key
  force_delete = true # Allow deletion even if images exist

  tags = {
    Name = each.key
  }
}

###############################################################################
# Data source for Amazon Linux 2023 ARM64 AMI
###############################################################################
data "aws_ami" "amazon_linux_arm64" {
  most_recent = true
  owners      = ["amazon"]

  filter {
    name   = "name"
    values = ["al2023-ami-2023*-arm64"]
  }

  filter {
    name   = "virtualization-type"
    values = ["hvm"]
  }

  filter {
    name   = "architecture"
    values = ["arm64"]
  }
}

###############################################################################
# Redis EC2 Instance
###############################################################################
resource "aws_instance" "redis_instance" {
  ami                    = data.aws_ami.amazon_linux_arm64.id
  instance_type          = var.redis_instance_type
  subnet_id              = aws_default_subnet.default_a.id
  vpc_security_group_ids = [aws_security_group.redis_security_group.id]
  iam_instance_profile   = aws_iam_instance_profile.redis_instance_profile.name
  key_name               = "nicolas"
  monitoring             = true

  user_data = <<-EOT
    #!/bin/bash
    set -e
    
    # Update system
    dnf update -y
    
    # Install Docker
    dnf install -y docker
    systemctl enable docker
    systemctl start docker
    
    # Wait for Docker daemon to be ready
    sleep 10
    
    # Add ec2-user to docker group so they can run docker commands without sudo
    usermod -aG docker ec2-user
    
    # Ensure docker socket has correct permissions
    chmod 666 /var/run/docker.sock 2>/dev/null || true
    
    # Install CloudWatch agent
    wget https://s3.amazonaws.com/amazoncloudwatch-agent/amazon_linux/arm64/latest/amazon-cloudwatch-agent.rpm
    rpm -U ./amazon-cloudwatch-agent.rpm
    
    # Create CloudWatch agent config
    cat > /opt/aws/amazon-cloudwatch-agent/etc/config.json <<'CONFIG'
    {
      "logs": {
        "logs_collected": {
          "files": {
            "collect_list": [
              {
                "file_path": "/var/log/redis/*.log",
                "log_group_name": "${aws_cloudwatch_log_group.redis_log_group.name}",
                "log_stream_name": "{instance_id}/redis",
                "timezone": "UTC"
              },
              {
                "file_path": "/var/log/messages",
                "log_group_name": "${aws_cloudwatch_log_group.redis_log_group.name}",
                "log_stream_name": "{instance_id}/system",
                "timezone": "UTC"
              }
            ]
          }
        }
      },
      "metrics": {
        "namespace": "TradingBots/Redis",
        "metrics_collected": {
          "cpu": {
            "measurement": [
              {"name": "cpu_usage_active", "rename": "CPU_USAGE", "unit": "Percent"},
              {"name": "cpu_usage_iowait", "rename": "CPU_IOWAIT", "unit": "Percent"}
            ],
            "metrics_collection_interval": 60,
            "totalcpu": true
          },
          "disk": {
            "measurement": [
              {"name": "used_percent", "rename": "DISK_USED", "unit": "Percent"}
            ],
            "metrics_collection_interval": 60,
            "resources": ["*"]
          },
          "mem": {
            "measurement": [
              {"name": "mem_used_percent", "rename": "MEM_USED", "unit": "Percent"}
            ],
            "metrics_collection_interval": 60
          }
        }
      }
    }
    CONFIG
    
    # Start CloudWatch agent
    /opt/aws/amazon-cloudwatch-agent/bin/amazon-cloudwatch-agent-ctl \
      -a fetch-config \
      -m ec2 \
      -s \
      -c file:/opt/aws/amazon-cloudwatch-agent/etc/config.json
    
    # Create directory for Redis logs
    mkdir -p /var/log/redis
    chmod 777 /var/log/redis
    
    # Create Redis data directory
    mkdir -p /data/redis
    chmod 755 /data/redis
    
    # Run Redis container (remove if exists to allow idempotent runs)
    docker rm -f redis 2>/dev/null || true
    
    docker run -d \
      --name redis \
      --restart unless-stopped \
      -p 6379:6379 \
      -v /data/redis:/data \
      -v /var/log/redis:/var/log/redis \
      redis:8.4.0-alpine \
      redis-server \
      --appendonly yes \
      --appendfsync everysec \
      --logfile /var/log/redis/redis.log
    
    echo "Redis instance setup complete"
  EOT

  metadata_options {
    http_endpoint               = "enabled"
    http_tokens                 = "required"
    http_put_response_hop_limit = 1
  }

  lifecycle {
    create_before_destroy = false
    ignore_changes = [
      ami
    ]
  }

  tags = merge(
    local.common_tags,
    {
      Name = "trading-bot-redis-instance"
    }
  )
}

###############################################################################
# Elastic IPs for Application Instances (One per Bot)
###############################################################################
resource "aws_eip" "app_instance_eips" {
  for_each = local.bots
  domain   = "vpc"

  tags = merge(
    local.common_tags,
    {
      Name = "${each.key}-eip"
    }
  )
}

###############################################################################
# Application EC2 Instances (One per Bot)
###############################################################################
resource "aws_instance" "app_instances" {
  for_each = local.bots

  ami                    = data.aws_ami.amazon_linux_arm64.id
  instance_type          = var.app_instance_type
  subnet_id              = aws_default_subnet.default_a.id
  vpc_security_group_ids = [aws_security_group.app_security_group.id]
  iam_instance_profile   = aws_iam_instance_profile.app_instance_profile.name
  key_name               = "nicolas"
  monitoring             = true

  user_data = <<-EOT
    #!/bin/bash
    set -e
    
    # Update system
    dnf update -y
    
    # Install Docker
    dnf install -y docker
    systemctl enable docker
    systemctl start docker
    
    # Wait for Docker daemon to be ready
    sleep 10
    
    # Add ec2-user to docker group so they can run docker commands without sudo
    usermod -aG docker ec2-user
    
    # Ensure docker socket has correct permissions
    chmod 666 /var/run/docker.sock 2>/dev/null || true
    
    # Install CloudWatch agent
    wget https://s3.amazonaws.com/amazoncloudwatch-agent/amazon_linux/arm64/latest/amazon-cloudwatch-agent.rpm
    rpm -U ./amazon-cloudwatch-agent.rpm
    
    # Create CloudWatch agent config for ${each.key}
    cat > /opt/aws/amazon-cloudwatch-agent/etc/config.json <<'CONFIG'
    {
      "logs": {
        "logs_collected": {
          "files": {
            "collect_list": [
              {
                "file_path": "/var/log/trading-bot/${each.key}/error.log",
                "log_group_name": "${aws_cloudwatch_log_group.bot_log_groups[each.key].name}",
                "log_stream_name": "{instance_id}/error",
                "timezone": "UTC"
              },
              {
                "file_path": "/var/log/trading-bot/${each.key}/combined.log",
                "log_group_name": "${aws_cloudwatch_log_group.bot_log_groups[each.key].name}",
                "log_stream_name": "{instance_id}/combined",
                "timezone": "UTC"
              },
              {
                "file_path": "/var/log/messages",
                "log_group_name": "${aws_cloudwatch_log_group.bot_log_groups[each.key].name}",
                "log_stream_name": "{instance_id}/system",
                "timezone": "UTC"
              }
            ]
          }
        }
      },
      "metrics": {
        "namespace": "TradingBots/${each.key}",
        "metrics_collected": {
          "cpu": {
            "measurement": [
              {"name": "cpu_usage_active", "rename": "CPU_USAGE", "unit": "Percent"},
              {"name": "cpu_usage_idle", "rename": "CPU_IDLE", "unit": "Percent"},
              {"name": "cpu_usage_iowait", "rename": "CPU_IOWAIT", "unit": "Percent"}
            ],
            "metrics_collection_interval": 60,
            "totalcpu": true
          },
          "mem": {
            "measurement": [
              {"name": "mem_used_percent", "rename": "MEM_USED_PERCENT", "unit": "Percent"},
              {"name": "mem_available_percent", "rename": "MEM_AVAILABLE_PERCENT", "unit": "Percent"}
            ],
            "metrics_collection_interval": 60,
            "totalmem": true
          },
          "disk": {
            "measurement": [
              {"name": "used_percent", "rename": "DISK_USED_PERCENT", "unit": "Percent"}
            ],
            "metrics_collection_interval": 60,
            "resources": ["*"]
          },
          "diskio": {
            "measurement": [
              {"name": "io_time", "unit": "Milliseconds"},
              {"name": "read_bytes", "unit": "Bytes"},
              {"name": "write_bytes", "unit": "Bytes"},
              {"name": "reads", "rename": "DISK_READ_OPS", "unit": "Count"},
              {"name": "writes", "rename": "DISK_WRITE_OPS", "unit": "Count"}
            ],
            "metrics_collection_interval": 60,
            "resources": ["*"]
          },
          "netstat": {
            "measurement": [
              {"name": "tcp_established", "rename": "TCP_ESTABLISHED", "unit": "Count"},
              {"name": "tcp_time_wait", "rename": "TCP_TIME_WAIT", "unit": "Count"},
              {"name": "tcp_close_wait", "rename": "TCP_CLOSE_WAIT", "unit": "Count"},
              {"name": "tcp_listen", "rename": "TCP_LISTEN", "unit": "Count"},
              {"name": "tcp_syn_recv", "rename": "TCP_SYN_RECV", "unit": "Count"}
            ],
            "metrics_collection_interval": 60
          },
          "processes": {
            "measurement": [
              {"name": "running", "rename": "PROCESSES_RUNNING", "unit": "Count"},
              {"name": "sleeping", "rename": "PROCESSES_SLEEPING", "unit": "Count"},
              {"name": "dead", "rename": "PROCESSES_DEAD", "unit": "Count"}
            ],
            "metrics_collection_interval": 60
          },
          "procstat": [
            {
              "pattern": "${each.key}",
              "measurement": [
                "cpu_usage",
                "memory_rss",
                "num_threads",
                "num_fds"
              ],
              "metrics_collection_interval": 60
            }
          ],
          "swap": {
            "measurement": [
              {"name": "used_percent", "rename": "SWAP_USED_PERCENT", "unit": "Percent"},
              {"name": "free", "rename": "SWAP_FREE", "unit": "Bytes"}
            ],
            "metrics_collection_interval": 60
          },
          "system": {
            "measurement": [
              "load1",
              "load5",
              "load15"
            ],
            "metrics_collection_interval": 60
          }
        },
        "append_dimensions": {
          "InstanceId": "$${aws:InstanceId}",
          "BotName": "${each.key}"
        }
      }
    }
    CONFIG
    
    # Start CloudWatch agent
    /opt/aws/amazon-cloudwatch-agent/bin/amazon-cloudwatch-agent-ctl \
      -a fetch-config \
      -m ec2 \
      -s \
      -c file:/opt/aws/amazon-cloudwatch-agent/etc/config.json
    
    # Create directories for application logs
    mkdir -p /var/log/trading-bot/${each.key}
    chmod -R 755 /var/log/trading-bot
    
    echo "${each.key} instance setup complete"
  EOT

  metadata_options {
    http_endpoint               = "enabled"
    http_tokens                 = "required"
    http_put_response_hop_limit = 1
  }

  lifecycle {
    create_before_destroy = false
    ignore_changes = [
      ami
    ]
  }

  tags = merge(
    local.common_tags,
    {
      Name = "${each.key}-instance"
    }
  )
}

###############################################################################
# Associate Elastic IPs with Application Instances
###############################################################################
resource "aws_eip_association" "app_instance_eip_assocs" {
  for_each      = local.bots
  instance_id   = aws_instance.app_instances[each.key].id
  allocation_id = aws_eip.app_instance_eips[each.key].id
}

###############################################################################
# SNS to Slack Notifier Lambda
###############################################################################
resource "aws_lambda_function" "sns_to_slack_notification" {
  s3_bucket     = "algo-trading-bot"
  s3_key        = "lambdas/sns_to_slack_notification.zip"
  function_name = "sns-to-slack-notification"
  role          = aws_iam_role.sns_to_slack_notification_lambda_role.arn
  handler       = "index.handler"
  runtime       = "nodejs18.x"

  environment {
    variables = {
      SLACK_WEBHOOK_URL = var.slack_webhook_url
    }
  }

  tags = {
    Name = "sns-to-slack-notification"
  }
}

resource "aws_iam_role" "sns_to_slack_notification_lambda_role" {
  name        = "sns-to-slack-notification-lambda-role"
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

  tags = {
    Name = "trading-bot-resource-utilization-alarms"
  }
}

resource "aws_sns_topic_subscription" "lambda_slack_subscription" {
  topic_arn = aws_sns_topic.trading_bot_resource_utilization_alarms.arn
  protocol  = "lambda"
  endpoint  = aws_lambda_function.sns_to_slack_notification.arn
}

###############################################################################
# CloudWatch Alarms - Application Instances (One set per Bot)
###############################################################################
# CPU Utilization
resource "aws_cloudwatch_metric_alarm" "app_cpu_alarms" {
  for_each            = local.bots
  alarm_name          = "${each.key}-cpu-usage-alarm"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 2
  metric_name         = "CPU_USAGE"
  namespace           = "TradingBots/${each.key}"
  period              = 10 # 10 seconds
  statistic           = "Average"
  threshold           = 80
  alarm_description   = "CPU utilization is too high for ${each.key} instance"
  treat_missing_data  = "notBreaching"

  dimensions = {
    InstanceId = aws_instance.app_instances[each.key].id
    BotName    = each.key
  }

  alarm_actions = [aws_sns_topic.trading_bot_resource_utilization_alarms.arn]
  ok_actions    = [aws_sns_topic.trading_bot_resource_utilization_alarms.arn]

  tags = {
    Name = "${each.key}-cpu-usage-alarm"
    Bot  = each.key
  }
}

# CPU IOWait (I/O bottleneck detection)
resource "aws_cloudwatch_metric_alarm" "app_cpu_iowait_alarms" {
  for_each            = local.bots
  alarm_name          = "${each.key}-cpu-iowait-alarm"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 2
  metric_name         = "CPU_IOWAIT"
  namespace           = "TradingBots/${each.key}"
  period              = 10 # 10 seconds
  statistic           = "Average"
  threshold           = 30
  alarm_description   = "High CPU IOWait for ${each.key} - I/O bottleneck detected"
  treat_missing_data  = "notBreaching"

  dimensions = {
    InstanceId = aws_instance.app_instances[each.key].id
    BotName    = each.key
  }

  alarm_actions = [aws_sns_topic.trading_bot_resource_utilization_alarms.arn]
  ok_actions    = [aws_sns_topic.trading_bot_resource_utilization_alarms.arn]

  tags = {
    Name = "${each.key}-cpu-iowait-alarm"
    Bot  = each.key
  }
}

# Memory Utilization (from CloudWatch Agent)
resource "aws_cloudwatch_metric_alarm" "app_memory_alarms" {
  for_each            = local.bots
  alarm_name          = "${each.key}-memory-used-alarm"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 2
  metric_name         = "MEM_USED_PERCENT"
  namespace           = "TradingBots/${each.key}"
  period              = 10 # 10 seconds
  statistic           = "Average"
  threshold           = 80
  alarm_description   = "Memory utilization is too high for ${each.key} instance"
  treat_missing_data  = "notBreaching"

  dimensions = {
    InstanceId = aws_instance.app_instances[each.key].id
    BotName    = each.key
  }

  alarm_actions = [aws_sns_topic.trading_bot_resource_utilization_alarms.arn]
  ok_actions    = [aws_sns_topic.trading_bot_resource_utilization_alarms.arn]

  tags = {
    Name = "${each.key}-memory-used-alarm"
    Bot  = each.key
  }
}

# Disk Utilization
resource "aws_cloudwatch_metric_alarm" "app_disk_alarms" {
  for_each            = local.bots
  alarm_name          = "${each.key}-disk-used-alarm"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 2
  metric_name         = "DISK_USED_PERCENT"
  namespace           = "TradingBots/${each.key}"
  period              = 10 # 10 seconds
  statistic           = "Average"
  threshold           = 80
  alarm_description   = "Disk utilization is too high for ${each.key} instance"
  treat_missing_data  = "notBreaching"

  dimensions = {
    InstanceId = aws_instance.app_instances[each.key].id
    BotName    = each.key
  }

  alarm_actions = [aws_sns_topic.trading_bot_resource_utilization_alarms.arn]
  ok_actions    = [aws_sns_topic.trading_bot_resource_utilization_alarms.arn]

  tags = {
    Name = "${each.key}-disk-used-alarm"
    Bot  = each.key
  }
}

# Load Average (System overload detection)
resource "aws_cloudwatch_metric_alarm" "app_load_average_alarms" {
  for_each            = local.bots
  alarm_name          = "${each.key}-load-average-alarm"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 2
  metric_name         = "LOAD_AVERAGE_1M"
  namespace           = "TradingBots/${each.key}"
  period              = 10 # 10 seconds
  statistic           = "Average"
  threshold           = 2.0 # For 2 vCPU instance (c8g.large)
  alarm_description   = "High load average for ${each.key} - system overloaded"
  treat_missing_data  = "notBreaching"

  dimensions = {
    InstanceId = aws_instance.app_instances[each.key].id
    BotName    = each.key
  }

  alarm_actions = [aws_sns_topic.trading_bot_resource_utilization_alarms.arn]
  ok_actions    = [aws_sns_topic.trading_bot_resource_utilization_alarms.arn]

  tags = {
    Name = "${each.key}-load-average-alarm"
    Bot  = each.key
  }
}

# TCP Close Wait (Connection leak detection - CRITICAL)
resource "aws_cloudwatch_metric_alarm" "app_tcp_close_wait_alarms" {
  for_each            = local.bots
  alarm_name          = "${each.key}-tcp-close-wait-alarm"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 2
  metric_name         = "TCP_CLOSE_WAIT"
  namespace           = "TradingBots/${each.key}"
  period              = 10 # 10 seconds
  statistic           = "Average"
  threshold           = 100
  alarm_description   = "High TCP_CLOSE_WAIT for ${each.key} - connection leak detected (stuck sockets)"
  treat_missing_data  = "notBreaching"

  dimensions = {
    InstanceId = aws_instance.app_instances[each.key].id
    BotName    = each.key
  }

  alarm_actions = [aws_sns_topic.trading_bot_resource_utilization_alarms.arn]
  ok_actions    = [aws_sns_topic.trading_bot_resource_utilization_alarms.arn]

  tags = {
    Name = "${each.key}-tcp-close-wait-alarm"
    Bot  = each.key
  }
}

# Process File Descriptors (FD leak detection - CRITICAL)
resource "aws_cloudwatch_metric_alarm" "app_process_fds_alarms" {
  for_each            = local.bots
  alarm_name          = "${each.key}-process-fds-open-alarm"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 2
  metric_name         = "PROCESS_FDS_OPEN"
  namespace           = "TradingBots/${each.key}"
  period              = 10 # 10 seconds
  statistic           = "Average"
  threshold           = 800 # Critical - approaching system limit (typically 1024)
  alarm_description   = "High file descriptor count for ${each.key} - FD leak detected"
  treat_missing_data  = "notBreaching"

  dimensions = {
    InstanceId = aws_instance.app_instances[each.key].id
    BotName    = each.key
  }

  alarm_actions = [aws_sns_topic.trading_bot_resource_utilization_alarms.arn]
  ok_actions    = [aws_sns_topic.trading_bot_resource_utilization_alarms.arn]

  tags = {
    Name = "${each.key}-process-fds-open-alarm"
    Bot  = each.key
  }
}

# Status Check Failed
resource "aws_cloudwatch_metric_alarm" "app_status_check_alarms" {
  for_each            = local.bots
  alarm_name          = "${each.key}-status-check-alarm"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 2
  metric_name         = "StatusCheckFailed"
  namespace           = "AWS/EC2"
  period              = 10 # 10 seconds
  statistic           = "Average"
  threshold           = 0
  alarm_description   = "Status check failed for ${each.key} instance"
  treat_missing_data  = "notBreaching"

  dimensions = {
    InstanceId = aws_instance.app_instances[each.key].id
    BotName    = each.key
  }

  alarm_actions = [aws_sns_topic.trading_bot_resource_utilization_alarms.arn]

  tags = {
    Name = "${each.key}-status-check-alarm"
    Bot  = each.key
  }
}

###############################################################################
# CloudWatch Alarms - Redis Instance
###############################################################################
# CPU Utilization
resource "aws_cloudwatch_metric_alarm" "redis_cpu_alarm" {
  alarm_name          = "redis-instance-cpu-usage-alarm"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 2
  metric_name         = "CPUUtilization"
  namespace           = "AWS/EC2"
  period              = 10 # 10 seconds
  statistic           = "Average"
  threshold           = 80
  alarm_description   = "CPU utilization is too high for Redis instance"
  treat_missing_data  = "notBreaching"

  dimensions = {
    InstanceId = aws_instance.redis_instance.id
  }

  alarm_actions = [aws_sns_topic.trading_bot_resource_utilization_alarms.arn]
  ok_actions    = [aws_sns_topic.trading_bot_resource_utilization_alarms.arn]

  tags = {
    Name = "redis-instance-cpu-usage-alarm"
  }
}

# Memory Utilization (from CloudWatch Agent)
resource "aws_cloudwatch_metric_alarm" "redis_memory_alarm" {
  alarm_name          = "redis-instance-memory-used-alarm"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 2
  metric_name         = "MEM_USED_PERCENT"
  namespace           = "TradingBots/Redis"
  period              = 10 # 10 seconds
  statistic           = "Average"
  threshold           = 80
  alarm_description   = "Memory utilization is too high for Redis instance"
  treat_missing_data  = "notBreaching"

  dimensions = {
    InstanceId = aws_instance.redis_instance.id
  }

  alarm_actions = [aws_sns_topic.trading_bot_resource_utilization_alarms.arn]
  ok_actions    = [aws_sns_topic.trading_bot_resource_utilization_alarms.arn]

  tags = {
    Name = "redis-instance-memory-used-alarm"
  }
}

# Disk Space Utilization for Redis
resource "aws_cloudwatch_metric_alarm" "redis_disk_alarm" {
  alarm_name          = "redis-instance-disk-used-alarm"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 2
  metric_name         = "DISK_USED_PERCENT"
  namespace           = "TradingBots/Redis"
  period              = 10 # 10 seconds
  statistic           = "Average"
  threshold           = 80
  alarm_description   = "Disk utilization is too high for Redis instance"
  treat_missing_data  = "notBreaching"

  dimensions = {
    InstanceId = aws_instance.redis_instance.id
  }

  alarm_actions = [aws_sns_topic.trading_bot_resource_utilization_alarms.arn]
  ok_actions    = [aws_sns_topic.trading_bot_resource_utilization_alarms.arn]

  tags = {
    Name = "redis-instance-disk-used-alarm"
  }
}

# Status Check Failed
resource "aws_cloudwatch_metric_alarm" "redis_status_check_alarm" {
  alarm_name          = "redis-instance-status-check-alarm"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 2
  metric_name         = "StatusCheckFailed"
  namespace           = "AWS/EC2"
  period              = 60
  statistic           = "Average"
  threshold           = 0
  alarm_description   = "Status check failed for Redis instance"
  treat_missing_data  = "notBreaching"

  dimensions = {
    InstanceId = aws_instance.redis_instance.id
  }

  alarm_actions = [aws_sns_topic.trading_bot_resource_utilization_alarms.arn]

  tags = {
    Name = "redis-instance-status-check-alarm"
  }
}