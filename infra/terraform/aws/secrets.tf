# ─────────────────────────────────────────────────────────────────────────
# Secrets.
#
# Terraform creates the CONTAINERS. It never sees the values.
#
# That distinction matters: anything passed through a Terraform variable ends
# up in state as cleartext, so "manage the secret in Terraform" and "keep the
# secret out of state" are mutually exclusive. Values are written once with
# the AWS CLI (see README.md) and `ignore_changes` below stops Terraform
# fighting the rotation.
#
# ECS reads these by ARN at task start and injects them as environment
# variables inside the container. They never appear in the task definition,
# so `aws ecs describe-task-definition` - which anyone with read access to
# the cluster can call - shows only the ARN, not the value.
# ─────────────────────────────────────────────────────────────────────────

locals {
  # Secrets both workloads need.
  shared_secrets = toset([
    # Bypasses Postgres RLS entirely (see supabase/migrations/038), so this
    # is the highest-value credential either task holds.
    "SUPABASE_SERVICE_ROLE_KEY",
    # Decrypts stored GitHub OAuth tokens (AES-256-GCM, see lib/crypto.ts).
    "ENCRYPTION_KEY",
  ])

  # Secrets only the web app needs. The worker never authenticates a user,
  # never sends mail and never takes a payment, so it is not given the
  # credentials to do any of those things.
  web_secrets = toset([
    "AUTH_SECRET",
    "GITHUB_CLIENT_ID",
    "GITHUB_CLIENT_SECRET",
    "GITHUB_WEBHOOK_SECRET",
    "UPSTASH_REDIS_REST_TOKEN",
    "RESEND_API_KEY",
  ])

  all_secrets = setunion(local.shared_secrets, local.web_secrets)
}

resource "aws_secretsmanager_secret" "this" {
  for_each = local.all_secrets

  name        = "${var.name}/${each.key}"
  description = "ArchSetu - ${each.key}. Value written out of band; see infra/terraform/aws/README.md."

  # A deleted secret is unrecoverable once the window closes. Seven days is
  # enough to notice and cancel an accidental destroy.
  recovery_window_in_days = 7

  tags = { Name = "${var.name}-${lower(replace(each.key, "_", "-"))}" }
}

# Creates the FIRST version so the ARN resolves and ECS can start, with an
# obvious placeholder. Tasks will fail loudly on a placeholder rather than
# behaving strangely on an empty string - which is the intended behaviour
# before the real value is written.
resource "aws_secretsmanager_secret_version" "placeholder" {
  for_each = aws_secretsmanager_secret.this

  secret_id     = each.value.id
  secret_string = "REPLACE_ME_SEE_INFRA_README"

  lifecycle {
    # Without this, every apply after the real value is written would revert
    # it to the placeholder above - a self-inflicted outage on a routine
    # `terraform apply` that touched something else entirely.
    ignore_changes = [secret_string]
  }
}
