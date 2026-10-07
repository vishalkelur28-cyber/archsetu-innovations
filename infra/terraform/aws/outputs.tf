output "cloudfront_domain" {
  description = "Public hostname. Point the apex and www CNAME/ALIAS records here to cut over from Vercel."
  value       = aws_cloudfront_distribution.main.domain_name
}

output "alb_dns_name" {
  description = "ALB hostname. Not a usable entry point on its own - the listener 403s anything without the CloudFront origin-verify header. Useful for debugging target health."
  value       = aws_lb.main.dns_name
}

output "ecr_repositories" {
  description = "Push targets for the two images."
  value       = { for k, v in aws_ecr_repository.this : k => v.repository_url }
}

output "acm_validation_records" {
  description = "DNS records to create to validate both certificates. The CloudFront one is issued in us-east-1, the ALB one in the primary region; the same domain genuinely needs both."
  value = var.domain_name == "" ? {} : {
    alb        = [for o in aws_acm_certificate.alb[0].domain_validation_options : { name = o.resource_record_name, type = o.resource_record_type, value = o.resource_record_value }]
    cloudfront = [for o in aws_acm_certificate.cloudfront[0].domain_validation_options : { name = o.resource_record_name, type = o.resource_record_type, value = o.resource_record_value }]
  }
}

output "cluster_name" {
  description = "ECS cluster name, for `aws ecs` commands and the deploy workflow."
  value       = aws_ecs_cluster.main.name
}

output "secret_names" {
  description = "Secrets Manager entries created with placeholder values. Every one must be written before the first deploy - see README.md."
  value       = sort([for s in aws_secretsmanager_secret.this : s.name])
}
