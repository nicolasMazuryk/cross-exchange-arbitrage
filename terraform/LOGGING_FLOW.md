# Logging Flow: Application → CloudWatch

This document explains how logs flow from the application through Docker volumes to CloudWatch Logs.

## How It Works Together

```
┌─────────────────────────────────────────────────────────────────┐
│ 1. Application (Pino Logger)                                     │
│    └─> Writes to /app/logs/error.log + combined.log            │
│    └─> Also outputs to stdout/stderr (production)               │
└──────────────────┬──────────────────────────────────────────────┘
                   │
                   ▼
┌─────────────────────────────────────────────────────────────────┐
│ 2. Docker Volume Mount                                           │
│    └─> /app/logs ──mapped to──> /var/log/trading-bot/$BOT/     │
└──────────────────┬──────────────────────────────────────────────┘
                   │
                   ▼
┌─────────────────────────────────────────────────────────────────┐
│ 3. Host Filesystem                                               │
│    └─> /var/log/trading-bot/funding_arbitrage_bot/error.log     │
│    └─> /var/log/trading-bot/funding_arbitrage_bot/combined.log │
└──────────────────┬──────────────────────────────────────────────┘
                   │
                   ▼
┌─────────────────────────────────────────────────────────────────┐
│ 4. CloudWatch Agent                                              │
│    └─> Reads files and sends to CloudWatch Logs                │
└──────────────────┬──────────────────────────────────────────────┘
                   │
                   ▼
┌─────────────────────────────────────────────────────────────────┐
│ 5. CloudWatch Logs                                               │
│    └─> /ec2/trading-bots/funding_arbitrage_bot                  │
│        ├─> {instance_id}/error (errors only)                    │
│        ├─> {instance_id}/combined (all logs)                    │
│        └─> {instance_id}/system (system logs)                   │
└─────────────────────────────────────────────────────────────────┘
```

## Key Components

### Application (`src/utils/logger.ts`)
- Writes logs to `/app/logs/error.log` and `/app/logs/combined.log` inside the container
- Production mode also outputs to stdout/stderr

### Docker Volume Mount (`docker/deploy.sh`)
- Maps container `/app/logs` to host `/var/log/trading-bot/$BOT/`
- Example: `-v /var/log/trading-bot/funding_arbitrage_bot:/app/logs`

### CloudWatch Agent (`terraform/main.tf`)
- Configured to read from:
  - `/var/log/trading-bot/${bot_name}/error.log`
  - `/var/log/trading-bot/${bot_name}/combined.log`
  - `/var/log/messages` (system logs)
- Sends logs to CloudWatch Log Groups with 14-day retention

### CloudWatch Log Groups
- **Log Group**: `/ec2/trading-bots/{bot_name}`
- **Log Streams**:
  - `{instance_id}/error` - Error-level logs only
  - `{instance_id}/combined` - All application logs
  - `{instance_id}/system` - System messages

