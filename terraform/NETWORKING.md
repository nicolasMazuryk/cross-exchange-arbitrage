# ECS Network Architecture Documentation

## Overview

This document explains the network architecture for the ECS-based trading bot infrastructure. The setup uses a **two-subnet architecture** to solve critical networking requirements for ECS tasks running on EC2.

## The Problem

When using ECS with:
- **EC2 launch type** (not Fargate)
- **awsvpc network mode** (required for advanced networking)

You encounter a fundamental networking challenge:

1. **Task ENIs don't get public IPs** - Even when deployed in public subnets, task ENIs created by ECS do not receive public IP addresses.
2. **Tasks need internet access** - Trading bots must connect to exchange APIs and WebSocket feeds.
3. **ECS Agent requires stable connectivity** - The ECS agent on the EC2 instance needs reliable access to AWS APIs to report health and receive task assignments.

### Why a Single-Subnet Approach Fails

If you use a single subnet with NAT Gateway routing:
- ❌ The EC2 instance routes through NAT
- ❌ ECS agent loses connection to AWS APIs
- ❌ Tasks fail to start because "agent is not connected"
- ❌ The system becomes unstable

## The Solution: Two-Subnet Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                           VPC (default)                         │
│                                                                 │
│  ┌───────────────────────┐      ┌──────────────────────────┐  │
│  │  PUBLIC SUBNET        │      │  PRIVATE SUBNET          │  │
│  │  (default_a)          │      │  (ecs_tasks_private)     │  │
│  │                       │      │                          │  │
│  │  ┌─────────────────┐ │      │  ┌────────────────────┐ │  │
│  │  │  EC2 Instance   │ │      │  │  Task ENI 1        │ │  │
│  │  │  + ECS Agent    │ │      │  │  (No public IP)    │ │  │
│  │  │  + Elastic IP   │ │      │  └────────────────────┘ │  │
│  │  └─────────────────┘ │      │                          │  │
│  │         │             │      │  ┌────────────────────┐ │  │
│  │         │             │      │  │  Task ENI 2        │ │  │
│  │  ┌──────▼──────────┐ │      │  │  (No public IP)    │ │  │
│  │  │  NAT Gateway    │ │      │  └────────────────────┘ │  │
│  │  └──────┬──────────┘ │      │         │                │  │
│  │         │             │      │         │                │  │
│  │    Routes via IGW    │      │    Routes via NAT ───────┼──┘
│  └─────────┼─────────────┘      └─────────┼───────────────┘
│            │                              │
│       ┌────▼──────┐                      │
│       │    IGW    │◄─────────────────────┘
│       └────┬──────┘
│            │
└────────────┼────────────────────────────────────────────────────┘
             │
          Internet
```

### Network Flow

**EC2 Instance (ECS Agent):**
```
ECS Agent → EC2 Instance → Public Subnet → Internet Gateway → AWS APIs
```

**Task Containers:**
```
Task → Task ENI → Private Subnet → NAT Gateway → Public Subnet → IGW → Internet
```

## Infrastructure Components

### 1. Public Subnet (`default_a`)

**Purpose:** Hosts the EC2 instance running the ECS agent

**Configuration:**
- CIDR: `172.31.0.0/20` (default VPC subnet)
- Availability Zone: `${region}a`
- `map_public_ip_on_launch`: `true`
- Routing: Uses VPC main route table (routes through Internet Gateway)

**Resources:**
- EC2 instance with ECS agent
- Elastic IP (provides stable public IP)
- NAT Gateway (for task traffic)

### 2. Private Subnet (`ecs_tasks_private`)

**Purpose:** Hosts task ENIs for ECS containers

**Configuration:**
- CIDR: `172.31.128.0/20` (custom subnet in default VPC)
- Availability Zone: `${region}a`
- `map_public_ip_on_launch`: `false` (not needed)
- Routing: Custom route table routes all traffic through NAT Gateway

**Resources:**
- Task ENIs (created dynamically by ECS)

### 3. NAT Gateway

**Purpose:** Provides internet access for task ENIs in private subnet

**Location:** Deployed in public subnet (`default_a`)

**Characteristics:**
- Has Elastic IP for outbound connections
- Routes traffic from private subnet to Internet Gateway
- Costs: ~$0.045/hour + $0.045/GB data processed

### 4. Internet Gateway

**Purpose:** Provides internet access for public subnet

**Scope:** VPC-level resource (default VPC already has one)

**Usage:**
- EC2 instance traffic (ECS agent, SSH, etc.)
- NAT Gateway outbound traffic

### 5. Route Tables

**Main Route Table (Public Subnet):**
```
Destination     Target
172.31.0.0/16   local
0.0.0.0/0       igw-xxxxx (Internet Gateway)
```

**Custom Route Table (Private Subnet):**
```
Destination     Target
172.31.0.0/16   local
0.0.0.0/0       nat-xxxxx (NAT Gateway)
```

## Key Terraform Resources

### Network Resources
```hcl
# Public subnet - EC2 instance runs here
aws_default_subnet.default_a

# Private subnet - Task ENIs run here
aws_subnet.ecs_tasks_private

# NAT Gateway components
aws_eip.nat_gateway_eip
aws_nat_gateway.trading_bots_nat

# Route table for private subnet
aws_route_table.ecs_tasks_route_table
aws_route_table_association.ecs_tasks_private_subnet
```

### ECS Configuration
```hcl
# EC2 instance in PUBLIC subnet
resource "aws_instance" "ecs_instance" {
  subnet_id = aws_default_subnet.default_a.id  # Public subnet
  # ... routes through IGW
}

# ECS service uses PRIVATE subnet for tasks
resource "aws_ecs_service" "services" {
  network_configuration {
    subnets = [aws_subnet.ecs_tasks_private.id]  # Private subnet
    # ... tasks route through NAT
  }
}
```

## Why This Works

✅ **ECS Agent Connectivity:** EC2 instance in public subnet has direct IGW access → agent stays connected

✅ **Task Internet Access:** Task ENIs in private subnet route through NAT Gateway → can reach exchanges

✅ **Cost Efficiency:** Single NAT Gateway handles all task traffic

✅ **Security:** Task ENIs don't need public IPs, reducing attack surface

✅ **Scalability:** Can add more task ENIs to private subnet as needed

## Important Notes

### Why `assign_public_ip` Doesn't Work

You might think setting `assign_public_ip = true` in the ECS service network configuration would solve this. However:

❌ **This parameter is NOT supported for EC2 launch type**
- Only works with Fargate launch type
- Terraform will return an error if you try to use it with EC2

### Memory Reservation

The container memory reservation is set to **3300 MB** for `c6gn.large` instances (4 GiB total).

This leaves ~700 MB for:
- ECS agent (~150-200 MB)
- OS overhead (~400-500 MB)
- Temporary spikes and buffers (~100-150 MB)

If tasks fail with "insufficient memory," reduce the reservation in `locals.instance_memory`.

### Cost Implications

**NAT Gateway Costs:**
- Hourly: ~$0.045/hour = ~$32.40/month
- Data Processing: ~$0.045/GB processed
- **Total:** Typically $35-50/month depending on traffic

**Alternative:** Could use a NAT instance (self-managed EC2) to save costs, but adds complexity.

## Troubleshooting

### Task Fails to Start: "Agent not connected"

**Cause:** EC2 instance is routing through NAT instead of IGW

**Solution:**
1. Verify EC2 instance is in public subnet (`default_a`)
2. Check that public subnet uses main route table (routes to IGW)
3. Verify Elastic IP is associated with EC2 instance

### Task Fails to Start: "Insufficient memory"

**Cause:** Container memory reservation too high for available instance memory

**Solution:**
1. Check container instance available memory:
   ```bash
   aws ecs describe-container-instances --cluster trading-bots-cluster \
     --container-instances <arn> --query 'containerInstances[0].remainingResources'
   ```
2. Reduce memory reservation in `locals.instance_memory`
3. Or upgrade to larger instance type

### Tasks Can't Connect to Internet

**Cause:** NAT Gateway not properly configured or route table not associated

**Solution:**
1. Verify NAT Gateway is in public subnet and has EIP
2. Check private subnet route table has route to NAT Gateway:
   ```bash
   aws ec2 describe-route-tables --filters "Name=association.subnet-id,Values=<private-subnet-id>"
   ```
3. Verify NAT Gateway is in "available" state

### ECS Agent Disconnects Intermittently

**Cause:** Possible network instability or routing issue

**Solution:**
1. Check EC2 instance status checks (system and instance)
2. Verify security group allows outbound traffic
3. Check CloudWatch logs for ECS agent errors:
   ```bash
   # SSH to instance and check logs
   sudo journalctl -u ecs -f
   ```

## Migration from Single-Subnet Setup

If you're migrating from a single-subnet setup with NAT routing:

1. **Create private subnet** (already in Terraform)
2. **Apply Terraform changes** - this will:
   - Create private subnet
   - Create NAT Gateway and routing
   - Update ECS service to use private subnet
3. **Force new deployment** (if needed):
   ```bash
   aws ecs update-service --cluster trading-bots-cluster \
     --service funding_arbitrage_bot-service --force-new-deployment
   ```
4. **Verify:** Check that ECS agent stays connected and tasks start successfully

## References

- [ECS Task Networking](https://docs.aws.amazon.com/AmazonECS/latest/developerguide/task-networking.html)
- [NAT Gateways](https://docs.aws.amazon.com/vpc/latest/userguide/vpc-nat-gateway.html)
- [ECS EC2 Launch Type](https://docs.aws.amazon.com/AmazonECS/latest/developerguide/launch_types.html)
