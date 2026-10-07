variable "region" {
  description = "Primary AWS region. ap-south-1 matches the existing archsetu-analysis-results S3 bucket and sits closest to the Supabase instance the worker polls."
  type        = string
  default     = "ap-south-1"
}

variable "name" {
  description = "Name prefix for every resource."
  type        = string
  default     = "archsetu"
}

variable "domain_name" {
  description = "Apex domain served by CloudFront, e.g. archsetu.com. Leave empty to deploy without a custom domain and use the CloudFront default hostname."
  type        = string
  default     = ""
}

variable "vpc_cidr" {
  description = "VPC CIDR. /16 leaves plenty of room; subnets below carve /20s out of it."
  type        = string
  default     = "10.20.0.0/16"
}

# ── Images ────────────────────────────────────────────────────────────────
# No defaults and no ':latest'. A mutable tag makes the running revision
# unidentifiable from this configuration and leaves a rollback with nothing
# to roll back to. CI passes commit-SHA tags.

variable "web_image" {
  description = "Fully-qualified image for the Next.js web app (built from Dockerfile.web)."
  type        = string

  validation {
    condition     = !endswith(var.web_image, ":latest")
    error_message = "Refusing a ':latest' tag: pin a digest or commit-SHA tag so the deployed revision is identifiable and reversible."
  }
}

variable "worker_image" {
  description = "Fully-qualified image for the analysis worker (built from Dockerfile.worker)."
  type        = string

  validation {
    condition     = !endswith(var.worker_image, ":latest")
    error_message = "Refusing a ':latest' tag: pin a digest or commit-SHA tag so the deployed revision is identifiable and reversible."
  }
}

# ── Task sizing ───────────────────────────────────────────────────────────

variable "web_cpu" {
  description = "Fargate CPU units for the web task (1024 = 1 vCPU)."
  type        = number
  default     = 512
}

variable "web_memory" {
  description = "Fargate memory (MiB) for the web task."
  type        = number
  default     = 1024
}

variable "web_desired_count" {
  description = "Number of web tasks. 2 gives the ALB something to shift to during a deploy and survives a single-AZ failure."
  type        = number
  default     = 2
}

# The worker's own budget arithmetic in apps/web/workers/analysis.worker.mts
# assumes 2 vCPU / 2GiB with CONCURRENCY=2 forked children each capped at
# CHILD_MAX_OLD_SPACE_MB=512. Changing these without revisiting that comment
# breaks the assumption silently - the failure mode is the OOM-killer sending
# SIGKILL to a child mid-analysis, which the worker reports as an ordinary
# job failure rather than a misconfiguration.
variable "worker_cpu" {
  description = "Fargate CPU units for the worker. See the CONCURRENCY comment in analysis.worker.mts before changing."
  type        = number
  default     = 2048
}

variable "worker_memory" {
  description = "Fargate memory (MiB) for the worker. See the CHILD_MAX_OLD_SPACE_MB budget in analysis.worker.mts before changing."
  type        = number
  default     = 4096
}

variable "log_retention_days" {
  description = "CloudWatch Logs retention. Logs default to never expiring, which is a slow, silent cost leak."
  type        = number
  default     = 30
}

variable "supabase_url" {
  description = "Supabase project URL. Not a secret - it is a NEXT_PUBLIC_* value in the web app - so it is passed as a plain env var rather than through Secrets Manager."
  type        = string
}
