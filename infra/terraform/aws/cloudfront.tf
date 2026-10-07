# ─────────────────────────────────────────────────────────────────────────
# CloudFront.
#
# The public entry point, and the piece that replaces what Vercel's edge did
# for free: caching Next's immutable build assets close to users instead of
# serving every .js chunk from two Fargate tasks in ap-south-1.
#
# Without this in front, every static asset request would cross the ALB and
# occupy a Node process that should be rendering pages.
# ─────────────────────────────────────────────────────────────────────────

resource "aws_acm_certificate" "cloudfront" {
  count    = var.domain_name == "" ? 0 : 1
  provider = aws.us_east_1 # CloudFront accepts certificates from us-east-1 only

  domain_name               = var.domain_name
  subject_alternative_names = ["www.${var.domain_name}"]
  validation_method         = "DNS"

  lifecycle {
    create_before_destroy = true
  }
}

# ── Cache policies ───────────────────────────────────────────────────────

# /_next/static/* is content-hashed by the build: a given URL's bytes never
# change, so it can be cached effectively forever and never revalidated.
resource "aws_cloudfront_cache_policy" "static_assets" {
  name        = "${var.name}-static-assets"
  default_ttl = 31536000
  max_ttl     = 31536000
  min_ttl     = 31536000

  parameters_in_cache_key_and_forwarded_to_origin {
    enable_accept_encoding_brotli = true
    enable_accept_encoding_gzip   = true
    cookies_config { cookie_behavior = "none" }
    headers_config { header_behavior = "none" }
    query_strings_config { query_string_behavior = "none" }
  }
}

# Everything else is dynamic and must not be cached by default.
#
# This app renders per-user pages (dashboards, /coderspace) and sets
# auth cookies; caching HTML without extreme care risks serving one user's
# page to another. The origin decides cacheability via its own
# Cache-Control headers - `min_ttl = 0` with the auth cookie in the cache key
# means a page Next marks public can still be cached, while anything
# carrying a session is keyed per session.
resource "aws_cloudfront_cache_policy" "dynamic" {
  name        = "${var.name}-dynamic"
  default_ttl = 0
  max_ttl     = 31536000
  min_ttl     = 0

  parameters_in_cache_key_and_forwarded_to_origin {
    enable_accept_encoding_brotli = true
    enable_accept_encoding_gzip   = true

    cookies_config {
      cookie_behavior = "whitelist"
      cookies { items = ["authjs.session-token", "__Secure-authjs.session-token"] }
    }
    headers_config {
      header_behavior = "whitelist"
      headers { items = ["Accept", "Authorization", "Host", "RSC", "Next-Router-State-Tree", "Next-Router-Prefetch"] }
    }
    query_strings_config { query_string_behavior = "all" }
  }
}

# The origin needs the real client IP and protocol; without forwarding these
# the app sees the CloudFront edge as the client, which breaks IP-based rate
# limiting (getClientIp in lib/rate-limit.ts reads x-forwarded-for).
resource "aws_cloudfront_origin_request_policy" "to_alb" {
  name = "${var.name}-to-alb"

  cookies_config { cookie_behavior = "all" }
  query_strings_config { query_string_behavior = "all" }
  headers_config {
    header_behavior = "allViewerAndWhitelistCloudFront"
    headers { items = ["CloudFront-Viewer-Address", "CloudFront-Viewer-Country"] }
  }
}

# ── Distribution ─────────────────────────────────────────────────────────

resource "aws_cloudfront_distribution" "main" {
  enabled         = true
  is_ipv6_enabled = true
  comment         = "${var.name} web"
  aliases         = var.domain_name == "" ? [] : [var.domain_name, "www.${var.domain_name}"]

  # PriceClass_All keeps edges in every region including India, where most
  # of this traffic originates. The cheaper classes drop exactly those.
  price_class = "PriceClass_All"

  origin {
    domain_name = aws_lb.main.dns_name
    origin_id   = "alb"

    custom_origin_config {
      http_port  = 80
      https_port = 443
      # CloudFront -> ALB is HTTPS end to end; "match-viewer" would let a
      # plaintext viewer request become a plaintext origin request.
      origin_protocol_policy   = "https-only"
      origin_ssl_protocols     = ["TLSv1.2"]
      origin_read_timeout      = 60
      origin_keepalive_timeout = 60
    }

    # The shared secret the ALB listener rule requires. This is what makes
    # the ALB's own hostname useless to anyone who finds it.
    custom_header {
      name  = "X-Origin-Verify"
      value = random_password.origin_verify.result
    }
  }

  default_cache_behavior {
    target_origin_id       = "alb"
    viewer_protocol_policy = "redirect-to-https"
    compress               = true

    # HEAD/GET/OPTIONS alone would break every form post and API route.
    allowed_methods = ["GET", "HEAD", "OPTIONS", "PUT", "POST", "PATCH", "DELETE"]
    cached_methods  = ["GET", "HEAD"]

    cache_policy_id          = aws_cloudfront_cache_policy.dynamic.id
    origin_request_policy_id = aws_cloudfront_origin_request_policy.to_alb.id
  }

  ordered_cache_behavior {
    path_pattern           = "/_next/static/*"
    target_origin_id       = "alb"
    viewer_protocol_policy = "redirect-to-https"
    compress               = true
    allowed_methods        = ["GET", "HEAD", "OPTIONS"]
    cached_methods         = ["GET", "HEAD"]
    cache_policy_id        = aws_cloudfront_cache_policy.static_assets.id
  }

  restrictions {
    geo_restriction { restriction_type = "none" }
  }

  viewer_certificate {
    cloudfront_default_certificate = var.domain_name == "" ? true : false
    acm_certificate_arn            = var.domain_name == "" ? null : aws_acm_certificate.cloudfront[0].arn
    ssl_support_method             = var.domain_name == "" ? null : "sni-only"
    minimum_protocol_version       = var.domain_name == "" ? "TLSv1" : "TLSv1.2_2021"
  }
}
