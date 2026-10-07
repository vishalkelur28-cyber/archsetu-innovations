# Container registries, one per workload.
#
# Separate repositories rather than one with two tag prefixes: it keeps
# lifecycle policies, and any future per-repository IAM scoping, independent.

locals {
  repositories = toset(["web", "worker"])
}

resource "aws_ecr_repository" "this" {
  for_each = local.repositories

  name = "${var.name}/${each.key}"

  # Refuse to overwrite an existing tag. This is what makes a commit-SHA tag
  # a real identifier: without it, someone can re-push a different image
  # under a tag already deployed, and the task definition pinned to that tag
  # silently means something else. It also removes the "which build is
  # actually running?" question entirely.
  image_tag_mutability = "IMMUTABLE"

  image_scanning_configuration {
    # Scan every push for OS and language-package CVEs. This is the runtime
    # counterpart to `pnpm audit` in CI: that gates the dependencies we
    # declare, this catches vulnerabilities in the base image underneath them
    # (Debian packages in node:22-slim), which nothing else here looks at.
    scan_on_push = true
  }

  encryption_configuration {
    encryption_type = "AES256"
  }

  tags = { Name = "${var.name}-${each.key}" }
}

# Untagged images accumulate on every rebuild of a changed layer and are
# billed per GB indefinitely. Keeping ten tagged images is enough to roll
# back through a bad week without paying to store a year of them.
resource "aws_ecr_lifecycle_policy" "this" {
  for_each   = aws_ecr_repository.this
  repository = each.value.name

  policy = jsonencode({
    rules = [
      {
        rulePriority = 1
        description  = "Expire untagged images after 7 days"
        selection = {
          tagStatus   = "untagged"
          countType   = "sinceImagePushed"
          countUnit   = "days"
          countNumber = 7
        }
        action = { type = "expire" }
      },
      {
        rulePriority = 2
        description  = "Keep only the 10 most recent tagged images"
        selection = {
          tagStatus      = "tagged"
          tagPatternList = ["*"]
          countType      = "imageCountMoreThan"
          countNumber    = 10
        }
        action = { type = "expire" }
      },
    ]
  })
}
