# Worker infrastructure

Terraform for the ArchSetu analysis worker on Cloud Run.

## What this is, and what it is not

This **codifies infrastructure that already exists**. The worker was created
by hand through the console and `gcloud`, which meant its real configuration
— CPU, memory, scaling bounds, which service account it ran as — lived only
in someone's memory and in after-the-fact comments in
`apps/web/workers/analysis.worker.mts`. A change to it could not be reviewed,
the service could not be recreated if the project were lost, and nothing
verified that the running service still matched what the code assumed about
it.

It is **not** a fresh environment. Running `terraform apply` against an empty
state will create a *second* worker that competes with the existing one for
the same job queue. Import first.

## First run: adopt the existing resources

```bash
cd infra/terraform

cat > terraform.tfvars <<'EOF'
project_id   = "your-gcp-project"
supabase_url = "https://xxxxxxxx.supabase.co"
image        = "asia-south1-docker.pkg.dev/your-gcp-project/archsetu/worker@sha256:..."
EOF

terraform init

# Adopt what is already running, in this order.
terraform import google_service_account.worker \
  "projects/your-gcp-project/serviceAccounts/archsetu-worker@your-gcp-project.iam.gserviceaccount.com"
terraform import google_artifact_registry_repository.worker \
  "projects/your-gcp-project/locations/asia-south1/repositories/archsetu"
terraform import google_secret_manager_secret.supabase_service_role_key \
  "projects/your-gcp-project/secrets/archsetu-supabase-service-role-key"
terraform import google_cloud_run_v2_service.worker \
  "projects/your-gcp-project/locations/asia-south1/services/archsetu-worker"

# The important step. Read every line before applying anything.
terraform plan
```

That `plan` is the whole payoff: it is the first time the difference between
the intended configuration and the running one has ever been visible. Expect
a genuine diff — reconcile by correcting whichever side is actually wrong,
not by reflexively making the code match reality.

## Secrets

Secret *values* are never in this repository or in Terraform state. Terraform
creates the Secret Manager container; versions are written out of band:

```bash
printf '%s' "$SUPABASE_SERVICE_ROLE_KEY" | \
  gcloud secrets versions add archsetu-supabase-service-role-key --data-file=-
```

The service-role key bypasses Postgres RLS entirely (see
`supabase/migrations/038_enable_rls_on_all_remaining_tables.sql`), so it is
the highest-value credential the worker holds. It is injected as a secret
reference rather than a plain env var so it does not appear in
`gcloud run services describe` output or in Terraform state.

## Deploying a new version

```bash
IMAGE="asia-south1-docker.pkg.dev/$PROJECT/archsetu/worker:$(git rev-parse --short HEAD)"
docker build -f ../../Dockerfile.worker -t "$IMAGE" ../..
docker push "$IMAGE"
terraform apply -var="image=$IMAGE"
```

Tags are commit SHAs, never `:latest` — `variables.tf` rejects `:latest`
outright. A mutable tag makes the running revision unidentifiable from the
configuration and leaves a rollback with nothing to roll back to.

This replaces the previous deploy path (`.github/workflows/deploy-worker.yml`:
SSH to a VM, `git reset --hard origin/main`, `pnpm install`, `pm2 restart`).
That path had no artifact, no rollback, and required a long-lived SSH key in
CI with shell access to a host — and it broke in practice when a burst of
deploys got the runner's IP banned by fail2ban.

## Resource budget — read before changing `cpu` or `memory`

`analysis.worker.mts` computes its own limits against a **2 vCPU / 2GiB**
allocation: `CONCURRENCY = 2` forked children, each capped at
`CHILD_MAX_OLD_SPACE_MB = 512`. Those numbers were derived from the real
allocation, confirmed with `gcloud run services describe`.

Changing the values here without revisiting that comment breaks the
assumption silently. The failure mode is not a clear error — it is the OS
OOM-killer sending SIGKILL to a child mid-analysis, which the worker reports
as an ordinary job failure.

## State

`versions.tf` has a commented-out GCS backend. Configure it before a second
person runs `apply`: local state is unversioned, unlocked, unbacked-up, and
owned by exactly one machine.
