# ─────────────────────────────────────────────────────────────────────────
# ECS cluster and the two Fargate services.
# ─────────────────────────────────────────────────────────────────────────

resource "aws_ecs_cluster" "main" {
  name = var.name

  setting {
    # Per-task CPU/memory metrics. Worth the small cost here specifically
    # because the worker's memory budget is load-bearing: CHILD_MAX_OLD_SPACE_MB
    # is derived from the task's allocation, and without container-level
    # metrics an OOM-killed child is indistinguishable from an analysis that
    # failed on its own.
    name  = "containerInsights"
    value = "enabled"
  }
}

resource "aws_ecs_cluster_capacity_providers" "main" {
  cluster_name       = aws_ecs_cluster.main.name
  capacity_providers = ["FARGATE"]

  default_capacity_provider_strategy {
    capacity_provider = "FARGATE"
    weight            = 1
  }
}

resource "aws_cloudwatch_log_group" "this" {
  for_each = local.repositories

  name              = "/ecs/${var.name}/${each.key}"
  retention_in_days = var.log_retention_days
}

locals {
  # Values that are not secret: the Supabase URL is a NEXT_PUBLIC_* value in
  # the web app and is therefore public by construction, and the rest are
  # tuning knobs. Anything sensitive goes through `secrets` instead, below.
  common_env = [
    { name = "NODE_ENV", value = "production" },
  ]

  # Rendered from the Secrets Manager ARNs so the task definition carries a
  # reference, never a value.
  secret_refs = {
    for service, keys in local.secrets_per_service :
    service => [for k in keys : { name = k, valueFrom = aws_secretsmanager_secret.this[k].arn }]
  }
}

# ── Web ───────────────────────────────────────────────────────────────────

resource "aws_ecs_task_definition" "web" {
  family                   = "${var.name}-web"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = var.web_cpu
  memory                   = var.web_memory
  execution_role_arn       = aws_iam_role.execution["web"].arn
  task_role_arn            = aws_iam_role.task["web"].arn

  runtime_platform {
    operating_system_family = "LINUX"
    cpu_architecture        = "ARM64" # Graviton: ~20% cheaper per task at identical performance here
  }

  container_definitions = jsonencode([
    {
      name      = "web"
      image     = var.web_image
      essential = true

      portMappings = [{ containerPort = 3000, protocol = "tcp" }]

      environment = concat(local.common_env, [
        { name = "PORT", value = "3000" },
        { name = "HOSTNAME", value = "0.0.0.0" }, # Next's standalone server binds localhost otherwise, and the ALB health check would never pass
      ])
      secrets = local.secret_refs["web"]

      # Hits the app's own route rather than `/`, so a 200 means Next is
      # actually serving and not merely that the process is alive.
      healthCheck = {
        command     = ["CMD-SHELL", "node -e \"fetch('http://127.0.0.1:3000/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))\""]
        interval    = 30
        timeout     = 5
        retries     = 3
        startPeriod = 30
      }

      logConfiguration = {
        logDriver = "awslogs"
        options = {
          "awslogs-group"         = aws_cloudwatch_log_group.this["web"].name
          "awslogs-region"        = var.region
          "awslogs-stream-prefix" = "web"
        }
      }

      # Defence in depth against a container escape. Next writes nothing to
      # disk at runtime in standalone mode except its cache, which gets an
      # explicit writable mount below.
      readonlyRootFilesystem = true
      mountPoints            = [{ sourceVolume = "cache", containerPath = "/app/.next/cache", readOnly = false }]
      linuxParameters        = { initProcessEnabled = true } # reaps zombies; without it a crashed task can linger as a defunct PID 1
    }
  ])

  volume {
    name = "cache"
  }
}

resource "aws_ecs_service" "web" {
  name            = "${var.name}-web"
  cluster         = aws_ecs_cluster.main.id
  task_definition = aws_ecs_task_definition.web.arn
  desired_count   = var.web_desired_count
  launch_type     = "FARGATE"

  network_configuration {
    subnets          = aws_subnet.private[*].id
    security_groups  = [aws_security_group.web.id]
    assign_public_ip = false # private subnets; egress goes via NAT
  }

  load_balancer {
    target_group_arn = aws_lb_target_group.web.arn
    container_name   = "web"
    container_port   = 3000
  }

  # Rolling deploy with a circuit breaker. Without this, a task that crashes
  # on boot is restarted forever while the deploy reports "in progress" - the
  # breaker fails it and puts the previous task definition back automatically.
  deployment_circuit_breaker {
    enable   = true
    rollback = true
  }

  # 100/200 means a new task is fully healthy before an old one is drained,
  # so a deploy never reduces capacity below desired_count.
  deployment_minimum_healthy_percent = 100
  deployment_maximum_percent         = 200

  # Gives the app time to warm before the ALB counts a slow first response
  # against it.
  health_check_grace_period_seconds = 60

  # Without this the very first apply can fail: ECS refuses to register
  # targets with a listener that does not exist yet.
  depends_on = [aws_lb_listener.https]

  lifecycle {
    # CI deploys by registering a new task definition revision and updating
    # the service. Terraform should not then revert it to whatever image was
    # last applied - that would silently roll production back to an older
    # build on an unrelated `terraform apply`.
    ignore_changes = [task_definition, desired_count]
  }
}

# ── Worker ────────────────────────────────────────────────────────────────

resource "aws_ecs_task_definition" "worker" {
  family                   = "${var.name}-worker"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = var.worker_cpu
  memory                   = var.worker_memory
  execution_role_arn       = aws_iam_role.execution["worker"].arn
  task_role_arn            = aws_iam_role.task["worker"].arn

  runtime_platform {
    operating_system_family = "LINUX"
    cpu_architecture        = "ARM64"
  }

  container_definitions = jsonencode([
    {
      name      = "worker"
      image     = var.worker_image
      essential = true

      environment = concat(local.common_env, [
        { name = "NEXT_PUBLIC_SUPABASE_URL", value = var.supabase_url },
        # Pinned explicitly rather than left to the code's default so the
        # memory budget is visible in the deployment, not only in a source
        # comment. See analysis.worker.mts.
        { name = "CHILD_MAX_OLD_SPACE_MB", value = "512" },
        { name = "PORT", value = "8080" },
      ])
      secrets = local.secret_refs["worker"]

      logConfiguration = {
        logDriver = "awslogs"
        options = {
          "awslogs-group"         = aws_cloudwatch_log_group.this["worker"].name
          "awslogs-region"        = var.region
          "awslogs-stream-prefix" = "worker"
        }
      }

      # NOT read-only, unlike the web task: this container's entire job is
      # `git clone` onto disk. Scoped to an explicit ephemeral volume at the
      # path the worker already uses, so the rest of the filesystem stays
      # immutable rather than the whole container being writable.
      readonlyRootFilesystem = true
      mountPoints            = [{ sourceVolume = "jobs", containerPath = "/tmp", readOnly = false }]
      linuxParameters        = { initProcessEnabled = true }
    }
  ])

  volume {
    name = "jobs"
  }

  # Cloning large repositories needs more than the 20GiB default. The
  # worker's own size gate rejects anything that would not fit well before
  # this becomes the binding limit.
  ephemeral_storage {
    size_in_gib = 40
  }
}

resource "aws_ecs_service" "worker" {
  name            = "${var.name}-worker"
  cluster         = aws_ecs_cluster.main.id
  task_definition = aws_ecs_task_definition.worker.arn

  # Exactly one, always on.
  #
  # Not autoscaled: the job-claim function (supabase/migrations/009) hands a
  # job to one worker at a time, and the CONCURRENCY=2 memory budget in
  # analysis.worker.mts is computed for a single task. A second task would
  # double real memory demand against the same per-task allocation while
  # contending for the same queue.
  desired_count = 1
  launch_type   = "FARGATE"

  network_configuration {
    subnets          = aws_subnet.private[*].id
    security_groups  = [aws_security_group.worker.id]
    assign_public_ip = false
  }

  # A worker mid-analysis should finish or requeue cleanly rather than being
  # replaced underneath itself, so only one task runs at a time across a
  # deploy. The worker's SIGTERM handler requeues its in-flight job.
  deployment_minimum_healthy_percent = 0
  deployment_maximum_percent         = 100

  deployment_circuit_breaker {
    enable   = true
    rollback = true
  }

  lifecycle {
    ignore_changes = [task_definition, desired_count]
  }
}
