variable "project_id" {
  description = "GCP project hosting the analysis worker."
  type        = string
}

variable "region" {
  description = "Region for Cloud Run and Artifact Registry. Kept near the Supabase instance (ap-south-1) to keep job-claim round-trips short."
  type        = string
  default     = "asia-south1"
}

variable "service_name" {
  description = "Cloud Run service name. Must match the existing service so this configuration adopts it rather than creating a second one."
  type        = string
  default     = "archsetu-worker"
}

variable "image" {
  description = <<-EOT
    Fully-qualified container image for the worker, built from Dockerfile.worker.

    Deliberately a required input with no default, and deliberately not
    ":latest". A mutable tag means the running revision cannot be identified
    from this configuration and a rollback has nothing to roll back to - pass
    an immutable digest or a commit-SHA tag from CI.
  EOT
  type        = string

  validation {
    condition     = !endswith(var.image, ":latest")
    error_message = "Refusing a ':latest' image tag: pin a digest or commit-SHA tag so the deployed revision is identifiable and reversible."
  }
}

# ── Worker resource budget ────────────────────────────────────────────────
#
# These are not arbitrary. apps/web/workers/analysis.worker.mts documents the
# arithmetic it depends on: CONCURRENCY=2 forked children, each capped at
# CHILD_MAX_OLD_SPACE_MB (512MB) of old-space, sized against a real 2 vCPU /
# 2GiB allocation confirmed via `gcloud run services describe`. Changing
# either value here without revisiting that comment will silently break the
# budget the worker assumes - the failure mode is the OS OOM-killer SIGKILLing
# a child mid-analysis, which the worker reports as a job failure rather than
# as a misconfiguration.

variable "cpu" {
  description = "vCPU per instance. See the CONCURRENCY comment in analysis.worker.mts before changing."
  type        = string
  default     = "2"
}

variable "memory" {
  description = "Memory per instance. See the CHILD_MAX_OLD_SPACE_MB budget arithmetic in analysis.worker.mts before changing."
  type        = string
  default     = "2Gi"
}

variable "supabase_url" {
  description = "Supabase project URL. Not a secret (it is a NEXT_PUBLIC_* value in the web app), so it is passed as a plain env var rather than through Secret Manager."
  type        = string
}
