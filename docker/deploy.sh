#!/bin/bash

aws ecr get-login-password --region eu-central-1 | docker login --username AWS --password-stdin 846941037195.dkr.ecr.eu-central-1.amazonaws.com

# Bot name to be pulled and started
BOT="funding_arbitrage_bot"
# BOT="spread_arbitrage_bot"

echo "Stopping and removing existing $BOT container..."
docker stop $BOT 2>/dev/null || true
docker rm $BOT 2>/dev/null || true

echo "Removing existing $BOT image..."
docker rmi "846941037195.dkr.ecr.eu-central-1.amazonaws.com/$BOT:latest" 2>/dev/null || true

echo "Pulling $BOT image from ECR..."
docker pull "846941037195.dkr.ecr.eu-central-1.amazonaws.com/$BOT:latest" || echo "Image not yet available for $BOT! Please build and push the image first."

docker run -d \
      --name $BOT \
      --restart unless-stopped \
      -v /var/log/trading-bot/$BOT:/app/logs \
      "846941037195.dkr.ecr.eu-central-1.amazonaws.com/$BOT:latest"
    
docker ps -a

echo "Container $BOT started successfully!"