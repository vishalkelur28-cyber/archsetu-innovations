# ─────────────────────────────────────────────────────────────────────────
# Application Load Balancer.
#
# Sits between CloudFront and the web tasks. CloudFront terminates the
# public TLS and caches; the ALB spreads across AZs, drains connections on
# deploy, and is the only thing permitted to reach the tasks at all.
# ─────────────────────────────────────────────────────────────────────────

resource "aws_lb" "main" {
  name               = "${var.name}-alb"
  load_balancer_type = "application"
  subnets            = aws_subnet.public[*].id
  security_groups    = [aws_security_group.alb.id]

  # Protects against accidental `terraform destroy` taking the public entry
  # point with it. Flip to false deliberately when tearing down for real.
  enable_deletion_protection = true

  # Next.js streams RSC payloads; the 60s default can cut a slow server
  # component render off mid-flight and surface as a truncated response.
  idle_timeout = 120

  # An ALB that drops a request without a target has no record of it
  # anywhere - these are the 4xx/5xx you cannot otherwise explain.
  drop_invalid_header_fields = true
}

resource "aws_lb_target_group" "web" {
  name        = "${var.name}-web"
  port        = 3000
  protocol    = "HTTP"
  vpc_id      = aws_vpc.main.id
  target_type = "ip" # awsvpc networking: tasks register by ENI address, not instance

  health_check {
    path                = "/api/health"
    matcher             = "200"
    interval            = 30
    timeout             = 5
    healthy_threshold   = 2
    unhealthy_threshold = 3
  }

  # Long enough for an in-flight request to finish on a task being replaced,
  # short enough that a deploy is not held open by idle keep-alives.
  deregistration_delay = 30

  # Ensures a replacement exists before the old one is destroyed when the
  # target group has to be recreated, rather than briefly having none.
  lifecycle {
    create_before_destroy = true
  }
}

# ── Certificate ──────────────────────────────────────────────────────────
#
# Regional certificate for the ALB. CloudFront needs its own in us-east-1
# (see cloudfront.tf) - the same domain therefore needs two certificates,
# which is an AWS constraint, not duplication for its own sake.
resource "aws_acm_certificate" "alb" {
  count = var.domain_name == "" ? 0 : 1

  domain_name               = var.domain_name
  subject_alternative_names = ["www.${var.domain_name}"]
  validation_method         = "DNS"

  lifecycle {
    create_before_destroy = true
  }
}

# ── Listeners ────────────────────────────────────────────────────────────

resource "aws_lb_listener" "http" {
  load_balancer_arn = aws_lb.main.arn
  port              = 80
  protocol          = "HTTP"

  # Redirect, never serve. Paired with the HSTS header the app already sets,
  # this means a plaintext request is answered exactly once and every
  # subsequent one is upgraded by the browser before it leaves.
  default_action {
    type = "redirect"
    redirect {
      port        = "443"
      protocol    = "HTTPS"
      status_code = "HTTP_301"
    }
  }
}

resource "aws_lb_listener" "https" {
  load_balancer_arn = aws_lb.main.arn
  port              = 443
  protocol          = "HTTPS"

  # TLS 1.2 minimum. TLS13-1-2-2021-06 offers 1.3 and falls back to 1.2, so
  # nothing below 1.2 is negotiable at all.
  ssl_policy      = "ELBSecurityPolicy-TLS13-1-2-2021-06"
  certificate_arn = var.domain_name == "" ? null : aws_acm_certificate.alb[0].arn

  # Default: reject anything that did not come through CloudFront.
  #
  # Without this the ALB's own DNS name is a second, uncached, unprotected
  # public entry point to the same application - bypassing CloudFront's
  # caching and any WAF attached to it. The shared-secret header below is
  # what CloudFront adds and only CloudFront knows.
  default_action {
    type = "fixed-response"
    fixed_response {
      content_type = "text/plain"
      message_body = "Direct access to this load balancer is not permitted. Use the CloudFront distribution."
      status_code  = "403"
    }
  }
}

resource "aws_lb_listener_rule" "from_cloudfront" {
  listener_arn = aws_lb_listener.https.arn
  priority     = 100

  action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.web.arn
  }

  condition {
    http_header {
      http_header_name = "X-Origin-Verify"
      values           = [random_password.origin_verify.result]
    }
  }
}

# Shared secret proving a request came through CloudFront.
#
# Generated rather than hand-set so it is never a value someone picked and
# reused. It does live in Terraform state, which is the argument for the
# encrypted S3 backend in versions.tf - and the blast radius if it leaks is
# bounded: an attacker gains the ability to bypass the CDN, not to
# authenticate as anyone.
resource "random_password" "origin_verify" {
  length  = 48
  special = false # header values with punctuation get mangled by intermediaries
}
