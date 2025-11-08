output "ecs_cluster_name" {
  description = "Name of the ECS cluster"
  value       = aws_ecs_cluster.trading_bots_cluster.name
}

output "ecs_cluster_arn" {
  description = "ARN of the ECS cluster"
  value       = aws_ecs_cluster.trading_bots_cluster.arn
}

# output "service_arns" {
#   description = "Map of service names to their ARNs"
#   value = {
#     funding_arbitrage_bot = aws_ecs_service.funding_arbitrage_bot.arn
#     spread_arbitrage_bot  = aws_ecs_service.spread_arbitrage_bot.arn
#   }
# }

# output "task_definition_arns" {
#   description = "Map of task definition ARNs"
#   value = {
#     funding_arbitrage_bot = aws_ecs_task_definition.funding_arbitrage_bot.arn
#     spread_arbitrage_bot  = aws_ecs_task_definition.spread_arbitrage_bot.arn
#   }
# }

# output "log_groups" {
#   description = "Map of CloudWatch log groups for each bot"
#   value = {
#     funding_arbitrage_bot = aws_cloudwatch_log_group.funding_arbitrage_bot.name
#     spread_arbitrage_bot  = aws_cloudwatch_log_group.spread_arbitrage_bot.name
#   }
# }