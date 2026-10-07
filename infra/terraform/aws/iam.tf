# ─────────────────────────────────────────────────────────────────────────
# IAM.
#
# Two role types per task, and the distinction is the whole point:
#
#   execution role - used by the ECS AGENT, before the container starts, to
#                    pull the image, read secrets and create log streams.
#   task role      - used by YOUR CODE at runtime, via the container
#                    credentials endpoint.
#
# Collapsing them into one role (common, and what AWS's own quickstarts
# often show) hands application code the permission to read every secret in
# the account. Keeping them separate means a remote-code-execution bug in the
# worker cannot enumerate secrets, because the running process never holds
# secretsmanager:GetSecretValue at all - the agent used it and exited.
# ─────────────────────────────────────────────────────────────────────────

data "aws_iam_policy_document" "ecs_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["ecs-tasks.amazonaws.com"]
    }
    # Stops another AWS account from assuming this role even if its ARN
    # leaks - the confused-deputy guard AWS recommends for service roles.
    condition {
      test     = "StringEquals"
      variable = "aws:SourceAccount"
      values   = [data.aws_caller_identity.current.account_id]
    }
  }
}

data "aws_caller_identity" "current" {}

# ── Execution roles ───────────────────────────────────────────────────────

resource "aws_iam_role" "execution" {
  for_each = local.repositories

  name               = "${var.name}-${each.key}-execution"
  description        = "ECS agent role for the ${each.key} task: pulls the image, reads secrets, writes logs. Never held by application code."
  assume_role_policy = data.aws_iam_policy_document.ecs_assume.json
}

resource "aws_iam_role_policy_attachment" "execution_managed" {
  for_each = aws_iam_role.execution

  role       = each.value.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy"
}

# The managed policy above covers ECR and CloudWatch Logs but NOT Secrets
# Manager, so each execution role gets read access to exactly the secrets its
# own task consumes - enumerated by ARN, never a wildcard. The worker cannot
# read AUTH_SECRET or the Resend key because they are not in its list.
locals {
  secrets_per_service = {
    web    = local.all_secrets
    worker = local.shared_secrets
  }
}

data "aws_iam_policy_document" "read_secrets" {
  for_each = local.secrets_per_service

  statement {
    sid       = "ReadOnlyThisServicesSecrets"
    actions   = ["secretsmanager:GetSecretValue"]
    resources = [for k in each.value : aws_secretsmanager_secret.this[k].arn]
  }
}

resource "aws_iam_role_policy" "execution_secrets" {
  for_each = local.secrets_per_service

  name   = "read-secrets"
  role   = aws_iam_role.execution[each.key].id
  policy = data.aws_iam_policy_document.read_secrets[each.key].json
}

# ── Task roles ────────────────────────────────────────────────────────────

resource "aws_iam_role" "task" {
  for_each = local.repositories

  name               = "${var.name}-${each.key}-task"
  description        = "Runtime identity for the ${each.key} container. Holds only what the application itself calls AWS for."
  assume_role_policy = data.aws_iam_policy_document.ecs_assume.json
}

# The worker writes completed analysis results to S3. That is the only AWS
# API the application code calls, so it is the only permission this role
# carries - scoped to objects inside the one bucket, with no s3:DeleteObject
# and no bucket-level administration.
data "aws_iam_policy_document" "worker_s3" {
  statement {
    sid       = "WriteAnalysisResults"
    actions   = ["s3:PutObject", "s3:GetObject", "s3:AbortMultipartUpload"]
    resources = ["arn:aws:s3:::archsetu-analysis-results/*"]
  }

  statement {
    sid       = "ListForMultipartUploads"
    actions   = ["s3:ListBucket", "s3:ListBucketMultipartUploads"]
    resources = ["arn:aws:s3:::archsetu-analysis-results"]
  }
}

resource "aws_iam_role_policy" "worker_s3" {
  name   = "analysis-results-s3"
  role   = aws_iam_role.task["worker"].id
  policy = data.aws_iam_policy_document.worker_s3.json
}

# The web task is granted nothing.
#
# Not an omission - it genuinely calls no AWS API. It talks to Supabase,
# GitHub and Upstash over HTTPS with credentials injected as environment
# variables, all of which are outside IAM. An empty task role is the honest
# representation of that, and it means an SSRF or RCE in the request path
# yields no AWS credentials worth having. Add a scoped policy here if and
# when the web app genuinely needs an AWS API.
