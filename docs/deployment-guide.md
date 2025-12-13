# Deployment Guide

## Overview

This guide describes the deployment process for ArbiNet in production environments. The system is designed to run on AWS EC2 with Redis for state management and CloudWatch for logging.

## Deployment Architecture

### Infrastructure Components

- **AWS EC2**: Container orchestration
- **ECR**: Docker image registry
- **EC2 Instances**: Application and Redis servers
- **CloudWatch Logs**: Centralized logging
- **Security Groups**: Network access control
- **IAM Roles**: Service permissions

### Deployment Flow

```
Source Code → Docker Build → ECR Push → Terraform Apply → ECS Deployment
```

## Prerequisites

### Required Tools

- **Docker**: For building container images
- **AWS CLI**: For ECR authentication and operations
- **Terraform**: For infrastructure provisioning
- **AWS Account**: With appropriate permissions

### Required Permissions

- ECR: Push/pull images
- ECS: Create/update services
- EC2: Launch instances, manage security groups
- CloudWatch: Create log groups, write logs
- IAM: Create roles and policies

## Build Process

### 1. Build Docker Image

**Funding Arbitrage Bot:**
```bash
cd docker
docker build -f Dockerfile.funding_arbitrage_bot -t funding_arbitrage_bot .
```

**Spread Arbitrage Bot:**
```bash
cd docker
docker build -f Dockerfile.spread_arbitrage_bot -t spread_arbitrage_bot .
```

### 2. Tag Image for ECR

```bash
# Get ECR repository URL from Terraform outputs
aws ecr describe-repositories --region eu-central-1

# Tag image
docker tag funding_arbitrage_bot:latest \
  846941037195.dkr.ecr.eu-central-1.amazonaws.com/funding_arbitrage_bot:latest
```

### 3. Push to ECR

**Authenticate:**
```bash
aws ecr get-login-password --region eu-central-1 | \
  docker login --username AWS --password-stdin \
  846941037195.dkr.ecr.eu-central-1.amazonaws.com
```

**Push Image:**
```bash
docker push 846941037195.dkr.ecr.eu-central-1.amazonaws.com/funding_arbitrage_bot:latest
```

**Or use provided script:**
```bash
npm run push:ecr
# Or
bash docker/push-to-ecr.sh
```

## Infrastructure Deployment

### 1. Configure Terraform Variables

Edit `terraform/variables.tf` or use environment variables:

```hcl
variable "aws_region" {
  default = "eu-central-1"
}

# Add other required variables
```

### 2. Initialize Terraform

```bash
cd terraform
terraform init
```

### 3. Plan Deployment

```bash
terraform plan
```

Review the plan to ensure correct resource creation.

### 4. Apply Infrastructure

```bash
terraform apply
```

This creates:
- ECR repositories
- EC2 instances (application and Redis)
- Security groups
- CloudWatch log groups
- IAM roles
- ECS cluster and services

**Or use npm script:**
```bash
npm run terraform
```

## Application Deployment

### Manual Deployment

**Using deploy script:**
```bash
bash docker/deploy.sh
```

This script:
1. Authenticates with ECR
2. Stops existing container
3. Pulls latest image
4. Starts new container with volume mounts

### Automated Deployment

**ECS Service Update:**
```bash
aws ecs update-service \
  --cluster trading-bots-cluster \
  --service funding-arbitrage-bot \
  --force-new-deployment \
  --region eu-central-1
```

## Configuration

### Production Configuration

**Strategy-Specific Configs:**
- `config/funding.production.yaml`: Funding arbitrage strategy
- `config/spread.production.yaml`: Spread arbitrage strategy

**Environment Variables:**
Set in Dockerfile or ECS task definition:
- `NODE_ENV=production`
- `STRATEGY=funding` or `STRATEGY=spread`
- Exchange API keys (from secure storage)

### Redis Configuration

**Connection:**
- URL: Configured in production YAML
- Host: Redis EC2 instance private IP
- Port: 6379
- Key Prefix: Strategy-specific (e.g., `funding:`)

### Logging Configuration

**CloudWatch Integration:**
- Log groups: `/ec2/trading-bots/{bot_name}`
- Log streams: `{instance_id}/{log_type}`
- Retention: 14 days
- Agent: CloudWatch Agent on EC2

**Log Flow:**
```
Application → /app/logs/ → Docker Volume → /var/log/trading-bot/{bot}/ → CloudWatch Agent → CloudWatch Logs
```

## Monitoring

### CloudWatch Logs

**View Logs:**
```bash
aws logs tail /ec2/trading-bots/funding_arbitrage_bot --follow
```

**Or via AWS Console:**
- Navigate to CloudWatch → Logs
- Select log group: `/ec2/trading-bots/{bot_name}`
- View log streams

### Application Health

**Check Container Status:**
```bash
docker ps
# Or via ECS
aws ecs describe-services --cluster trading-bots-cluster --services funding-arbitrage-bot
```

**Check Logs:**
```bash
docker logs funding_arbitrage_bot
# Or tail
docker logs -f funding_arbitrage_bot
```

### Redis Health

**Connect to Redis:**
```bash
# SSH to Redis instance
ssh ec2-user@redis-instance-ip

# Connect to Redis
redis-cli

# Check keys
KEYS funding:*

# Monitor commands
MONITOR
```

## Scaling

### Horizontal Scaling

**Multiple Instances:**
- Deploy multiple ECS tasks
- Shared Redis state
- Distributed locks (Redlock)
- Load balancing (if applicable)

**Auto-Scaling:**
- Configure ECS auto-scaling policies
- Based on CPU/memory metrics
- Or custom CloudWatch metrics

### Vertical Scaling

**Instance Sizing:**
- Adjust EC2 instance types in Terraform
- Consider CPU-intensive operations (Playwright)
- Memory for orderbook state
- Network bandwidth for WebSocket connections

## Security

### API Key Management

**Storage:**
- Environment variables in ECS task definition
- AWS Secrets Manager (recommended)
- Never in code or config files

**Rotation:**
- Regular rotation schedule
- Update ECS task definition
- Restart services after update

### Network Security

**Security Groups:**
- Application: Allow outbound to exchanges
- Redis: Allow inbound from application only
- SSH: Restricted to specific IPs

**VPC Configuration:**
- Private subnets for application
- Public subnets for load balancers (if used)
- NAT Gateway for outbound internet

### Access Control

**IAM Roles:**
- ECS task role: Minimal permissions
- EC2 instance role: CloudWatch, ECR access
- No admin permissions

## Backup and Recovery

### State Backup

**Redis Snapshots:**
```bash
# Manual snapshot
redis-cli BGSAVE

# Or use Redis persistence
# AOF enabled in docker-compose.yml
```

**Trade State:**
- Stored in Redis: `{prefix}tracked-trades`
- Regular backups recommended
- Restore on new instance if needed

### Disaster Recovery

**Recovery Process:**
1. Provision new infrastructure (Terraform)
2. Restore Redis from backup
3. Deploy application
4. Verify state recovery
5. Monitor for issues

## Troubleshooting

### Container Won't Start

**Check Logs:**
```bash
docker logs funding_arbitrage_bot
```

**Common Issues:**
- Missing environment variables
- Redis connection failure
- Invalid configuration
- Port conflicts

### Redis Connection Issues

**Verify Connectivity:**
```bash
# From application instance
redis-cli -h redis-instance-ip ping
```

**Check Security Groups:**
- Application SG can reach Redis SG
- Redis port 6379 open

### Exchange API Issues

**Check API Keys:**
- Verify keys in environment
- Check key permissions
- Verify IP whitelist (if configured)

**Network Issues:**
- Check outbound internet access
- Verify DNS resolution
- Check firewall rules

### Performance Issues

**Monitor Resources:**
- CPU usage
- Memory usage
- Network bandwidth
- Disk I/O

**Optimize:**
- Adjust instance sizes
- Optimize code
- Reduce logging verbosity
- Scale horizontally

## Maintenance

### Updates

**Application Update:**
1. Build new Docker image
2. Push to ECR
3. Update ECS service (force new deployment)
4. Monitor deployment

**Configuration Update:**
1. Update YAML config
2. Rebuild Docker image
3. Redeploy

**Infrastructure Update:**
1. Update Terraform config
2. Run `terraform plan`
3. Review changes
4. Run `terraform apply`

### Log Rotation

**CloudWatch:**
- Automatic retention (14 days)
- Manual export if needed

**Local Logs:**
- Docker log rotation
- Or manual cleanup

## Rollback

### Application Rollback

**Previous Image:**
```bash
# Tag previous version
docker tag funding_arbitrage_bot:previous \
  846941037195.dkr.ecr.eu-central-1.amazonaws.com/funding_arbitrage_bot:previous

# Update ECS service to use previous image
aws ecs update-service \
  --cluster trading-bots-cluster \
  --service funding-arbitrage-bot \
  --task-definition funding-arbitrage-bot:previous
```

### Infrastructure Rollback

**Terraform:**
```bash
# Revert to previous state
terraform state pull > backup.tfstate
terraform apply -backup=backup.tfstate
```

## Best Practices

### Deployment

- Test in staging first
- Use blue-green deployments
- Monitor during deployment
- Have rollback plan ready

### Monitoring

- Set up CloudWatch alarms
- Monitor error rates
- Track performance metrics
- Review logs regularly

### Security

- Rotate credentials regularly
- Use least privilege IAM roles
- Encrypt sensitive data
- Audit access logs

### Documentation

- Document deployment procedures
- Keep runbooks updated
- Document known issues
- Maintain change log

