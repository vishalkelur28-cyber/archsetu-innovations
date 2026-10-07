# ─────────────────────────────────────────────────────────────────────────
# Network.
#
# Two AZs, because an ALB requires subnets in at least two. Public subnets
# hold only the load balancer and the NAT gateway; every container runs in a
# private subnet with no route from the internet. That separation is the
# whole point of doing this in a VPC rather than on public Fargate IPs -
# a container that clones arbitrary third-party repositories and forks a
# parser over them should not be directly addressable.
# ─────────────────────────────────────────────────────────────────────────

data "aws_availability_zones" "available" {
  state = "available"
}

locals {
  azs = slice(data.aws_availability_zones.available.names, 0, 2)

  # 10.20.0.0/16 -> two /20 public, two /20 private, leaving most of the
  # range free for an RDS subnet group when the database moves (phase 4).
  public_subnets  = [cidrsubnet(var.vpc_cidr, 4, 0), cidrsubnet(var.vpc_cidr, 4, 1)]
  private_subnets = [cidrsubnet(var.vpc_cidr, 4, 8), cidrsubnet(var.vpc_cidr, 4, 9)]
}

resource "aws_vpc" "main" {
  cidr_block           = var.vpc_cidr
  enable_dns_support   = true
  enable_dns_hostnames = true # required for interface VPC endpoints to resolve

  tags = { Name = "${var.name}-vpc" }
}

resource "aws_internet_gateway" "main" {
  vpc_id = aws_vpc.main.id
  tags   = { Name = "${var.name}-igw" }
}

resource "aws_subnet" "public" {
  count                   = length(local.public_subnets)
  vpc_id                  = aws_vpc.main.id
  cidr_block              = local.public_subnets[count.index]
  availability_zone       = local.azs[count.index]
  map_public_ip_on_launch = false # nothing here should get an IP implicitly

  tags = { Name = "${var.name}-public-${local.azs[count.index]}", Tier = "public" }
}

resource "aws_subnet" "private" {
  count             = length(local.private_subnets)
  vpc_id            = aws_vpc.main.id
  cidr_block        = local.private_subnets[count.index]
  availability_zone = local.azs[count.index]

  tags = { Name = "${var.name}-private-${local.azs[count.index]}", Tier = "private" }
}

# ── Egress ────────────────────────────────────────────────────────────────
#
# ONE NAT gateway, not one per AZ.
#
# This is a deliberate cost/availability trade, not an oversight. A NAT
# gateway is ~$32/month before data charges, which at this project's scale is
# more than everything else in this file combined; two would make NAT the
# single largest line on the bill. The cost of the trade is that losing the
# NAT's AZ takes outbound internet with it for both AZs.
#
# That is acceptable here because the failure is degraded, not fatal: the web
# app's own traffic arrives through the ALB and CloudFront and is unaffected,
# and the worker is a queue consumer - jobs it cannot start stay queued and
# drain once egress returns. Revisit when there is revenue to justify the
# second gateway, or if the worker ever becomes latency-sensitive.
#
# NAT is genuinely required and cannot be replaced by VPC endpoints: the
# worker's entire job is `git clone` against arbitrary GitHub repositories,
# which is general internet egress. Endpoints only cover AWS service traffic.
resource "aws_eip" "nat" {
  domain = "vpc"
  tags   = { Name = "${var.name}-nat" }
}

resource "aws_nat_gateway" "main" {
  allocation_id = aws_eip.nat.id
  subnet_id     = aws_subnet.public[0].id
  depends_on    = [aws_internet_gateway.main]

  tags = { Name = "${var.name}-nat" }
}

resource "aws_route_table" "public" {
  vpc_id = aws_vpc.main.id

  route {
    cidr_block = "0.0.0.0/0"
    gateway_id = aws_internet_gateway.main.id
  }

  tags = { Name = "${var.name}-public" }
}

resource "aws_route_table" "private" {
  vpc_id = aws_vpc.main.id

  route {
    cidr_block     = "0.0.0.0/0"
    nat_gateway_id = aws_nat_gateway.main.id
  }

  tags = { Name = "${var.name}-private" }
}

resource "aws_route_table_association" "public" {
  count          = length(aws_subnet.public)
  subnet_id      = aws_subnet.public[count.index].id
  route_table_id = aws_route_table.public.id
}

resource "aws_route_table_association" "private" {
  count          = length(aws_subnet.private)
  subnet_id      = aws_subnet.private[count.index].id
  route_table_id = aws_route_table.private.id
}

# ── S3 gateway endpoint ───────────────────────────────────────────────────
#
# Free, and worth having on day one specifically because of this workload:
# completed analysis results are written to S3
# (archsetu-analysis-results.s3.ap-south-1.amazonaws.com), and those uploads
# are by far the largest volume of AWS-bound traffic here. Routed through the
# NAT gateway they would be billed per GB twice over - NAT processing plus
# data transfer. Through a gateway endpoint they never touch the NAT at all.
#
# Interface endpoints for ECR, Secrets Manager and CloudWatch Logs are
# deliberately NOT created yet: each costs ~$7.30/month per AZ, so the four
# useful ones would cost roughly as much as the NAT gateway they are meant to
# relieve. Image pulls are small and infrequent at two services. Add them
# when task count or deploy frequency makes NAT data charges exceed that.
resource "aws_vpc_endpoint" "s3" {
  vpc_id            = aws_vpc.main.id
  service_name      = "com.amazonaws.${var.region}.s3"
  vpc_endpoint_type = "Gateway"
  route_table_ids   = [aws_route_table.private.id]

  tags = { Name = "${var.name}-s3-endpoint" }
}

# ── Security groups ───────────────────────────────────────────────────────
#
# Written as separate rule resources rather than inline ingress/egress
# blocks. Inline blocks are authoritative for the whole group, so a rule
# added out-of-band is silently destroyed on the next apply with nothing in
# the plan explaining why - which is exactly the kind of drift that makes
# people distrust Terraform and start clicking in the console instead.

resource "aws_security_group" "alb" {
  name        = "${var.name}-alb"
  description = "Public entry point. Accepts HTTP/HTTPS from the internet."
  vpc_id      = aws_vpc.main.id

  tags = { Name = "${var.name}-alb" }
}

resource "aws_vpc_security_group_ingress_rule" "alb_https" {
  security_group_id = aws_security_group.alb.id
  description       = "HTTPS from anywhere"
  cidr_ipv4         = "0.0.0.0/0"
  from_port         = 443
  to_port           = 443
  ip_protocol       = "tcp"
}

resource "aws_vpc_security_group_ingress_rule" "alb_http" {
  security_group_id = aws_security_group.alb.id
  description       = "HTTP from anywhere - redirected to HTTPS by the listener, never served"
  cidr_ipv4         = "0.0.0.0/0"
  from_port         = 80
  to_port           = 80
  ip_protocol       = "tcp"
}

resource "aws_vpc_security_group_egress_rule" "alb_to_web" {
  security_group_id            = aws_security_group.alb.id
  description                  = "Forward to web tasks only"
  referenced_security_group_id = aws_security_group.web.id
  from_port                    = 3000
  to_port                      = 3000
  ip_protocol                  = "tcp"
}

# Web tasks: reachable ONLY from the ALB. Referencing the ALB's security
# group rather than a CIDR means this stays correct if subnets are ever
# renumbered, and makes the intent ("from the load balancer") explicit.
resource "aws_security_group" "web" {
  name        = "${var.name}-web"
  description = "Next.js tasks. Ingress from the ALB only."
  vpc_id      = aws_vpc.main.id

  tags = { Name = "${var.name}-web" }
}

resource "aws_vpc_security_group_ingress_rule" "web_from_alb" {
  security_group_id            = aws_security_group.web.id
  description                  = "App port, from the ALB only"
  referenced_security_group_id = aws_security_group.alb.id
  from_port                    = 3000
  to_port                      = 3000
  ip_protocol                  = "tcp"
}

resource "aws_vpc_security_group_egress_rule" "web_egress" {
  security_group_id = aws_security_group.web.id
  description       = "Outbound to Supabase, the GitHub API, S3 and OAuth providers"
  cidr_ipv4         = "0.0.0.0/0"
  ip_protocol       = "-1"
}

# Worker: no ingress rule at all, deliberately.
#
# A security group with no ingress rules denies all inbound traffic, which is
# correct here - the worker pulls jobs from a queue and nothing ever calls
# into it. The health listener in analysis.worker.mts exists only because
# Cloud Run required a port to probe; on ECS the container health check runs
# inside the task, so that port needs no network exposure whatsoever.
resource "aws_security_group" "worker" {
  name        = "${var.name}-worker"
  description = "Analysis worker. No ingress: it is a queue consumer, nothing calls it."
  vpc_id      = aws_vpc.main.id

  tags = { Name = "${var.name}-worker" }
}

resource "aws_vpc_security_group_egress_rule" "worker_egress" {
  security_group_id = aws_security_group.worker.id
  description       = "Outbound for git clone, the GitHub API, Supabase and S3 uploads"
  cidr_ipv4         = "0.0.0.0/0"
  ip_protocol       = "-1"
}
