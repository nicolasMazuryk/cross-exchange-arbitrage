#!/bin/bash

aws ecr get-login-password --region eu-central-1 | docker login --username AWS --password-stdin 846941037195.dkr.ecr.eu-central-1.amazonaws.com

# Bot names to be build and pushed to ECR
BOTS=("funding_arbitrage_bot")
# BOTS=("funding_arbitrage_bot" "spread_arbitrage_bot")

for BOT in "${BOTS[@]}"; do
    echo "Building and pushing $BOT..."
    
    docker build -f "./docker/Dockerfile.$BOT" -t "846941037195.dkr.ecr.eu-central-1.amazonaws.com/$BOT:latest" .
    
    docker push "846941037195.dkr.ecr.eu-central-1.amazonaws.com/$BOT:latest"
done

echo "All images have been pushed to ECR successfully!"