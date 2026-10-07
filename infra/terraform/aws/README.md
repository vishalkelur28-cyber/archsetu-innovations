# AWS — web + worker on ECS Fargate

Phases 1–3 of the migration off Vercel and Cloud Run. The database stays on
Supabase for now; see "What is deliberately not here" at the bottom.

## Shape

```
                    Route 53 / your DNS
                            │
                     CloudFront  (TLS, caching, the only public entry point)
                            │  X-Origin-Verify: <shared secret>
                            ▼
      ┌──────────── public subnets ────────────┐
      │        ALB  (443, 80→301)              │
      └────────────────┬───────────────────────┘
                       │  SG-to-SG, port 3000
      ┌──────────── private subnets ───────────┐
      │   web task ×2        worker task ×1    │
      │   (no public IP)     (no ingress rule) │
      └────────────────┬───────────────────────┘
                       │
              NAT gateway ──► github.com, Supabase, Upstash
              S3 gateway endpoint ──► analysis results (free, bypasses NAT)
```

Nothing that runs your code is reachable from the internet. The ALB's own
hostname 403s anything without the CloudFront origin-verify header, so the
CDN cannot be bypassed.

## First run

```bash
cd infra/terraform/aws

cat > terraform.tfvars <<'EOF'
domain_name  = "archsetu.com"     # or "" to deploy on the CloudFront hostname
supabase_url = "https://xxxxxxxx.supabase.co"
EOF

terraform init
terraform apply \
  -var="web_image=PLACEHOLDER:bootstrap" \
  -var="worker_image=PLACEHOLDER:bootstrap"
```

Chicken-and-egg: ECR must exist before an image can be pushed, and the task
definitions want an image. Apply once with placeholders — the services will
fail to pull and sit at 0 running tasks, which is expected — then push real
images and deploy.

### 1. Write the secrets

Terraform creates the containers with the literal value
`REPLACE_ME_SEE_INFRA_README` and never sees the real ones. `terraform output
secret_names` lists all eight.

```bash
for KEY in SUPABASE_SERVICE_ROLE_KEY ENCRYPTION_KEY AUTH_SECRET \
           GITHUB_CLIENT_ID GITHUB_CLIENT_SECRET GITHUB_WEBHOOK_SECRET \
           UPSTASH_REDIS_REST_TOKEN RESEND_API_KEY; do
  read -rsp "$KEY: " V; echo
  aws secretsmanager put-secret-value --secret-id "archsetu/$KEY" --secret-string "$V"
done
```

Tasks fail loudly on the placeholder rather than behaving strangely on an
empty string. That is intentional.

### 2. Validate the certificates

`terraform output acm_validation_records` gives the DNS records. There are
**two certificates for the same domain** — CloudFront only accepts
certificates from `us-east-1`, the ALB needs one in `ap-south-1`. That is an
AWS constraint, not duplication.

### 3. Set up the deploy role (OIDC, no access keys)

The deploy workflow authenticates with a short-lived OIDC token. There is no
long-lived AWS secret in GitHub — nothing to steal from repo settings,
nothing to rotate. Create a role trusting only this repository:

```json
{
  "Effect": "Allow",
  "Principal": { "Federated": "arn:aws:iam::<ACCOUNT>:oidc-provider/token.actions.githubusercontent.com" },
  "Action": "sts:AssumeRoleWithWebIdentity",
  "Condition": {
    "StringEquals": { "token.actions.githubusercontent.com:aud": "sts.amazonaws.com" },
    "StringLike":   { "token.actions.githubusercontent.com:sub": "repo:<OWNER>/Archsetu-Web:*" }
  }
}
```

Scope the `sub` condition to a branch (`:ref:refs/heads/main`) rather than
`:*` once you are confident — `:*` lets any branch or PR in the repo assume
the deploy role.

Store the role ARN as the `AWS_DEPLOY_ROLE_ARN` repository secret.

### 4. Deploy

Actions → **Deploy to AWS** → run. Or locally:

```bash
ECR=$(terraform output -json ecr_repositories | jq -r .web)
TAG=$(git rev-parse --short=12 HEAD)
docker buildx build --platform linux/arm64 -f ../../../Dockerfile.web \
  -t "$ECR:$TAG" --push ../../..
```

Images are ARM64 — the tasks run on Graviton, roughly 20% cheaper at
identical performance for this workload. Tags are commit SHAs; the ECR
repositories are `IMMUTABLE`, so re-pushing an existing tag is rejected
rather than silently changing what a deployed task points at.

### 5. Cut over DNS

Point the apex and `www` at `terraform output cloudfront_domain`. Keep the
Vercel deployment live until you are satisfied — rollback is a DNS change,
which is the cheapest rollback available.

## Costs

Roughly, at this scale, before credits:

| | /month |
|---|---|
| NAT gateway | ~$32 |
| ALB | ~$18 |
| Fargate — web, 2 × 0.5 vCPU/1GB ARM | ~$25 |
| Fargate — worker, 1 × 2 vCPU/4GB ARM | ~$50 |
| CloudFront, ECR, Secrets Manager, logs | ~$10 |
| **Total** | **~$135** |

The NAT gateway is the one people get surprised by: a single idle gateway
costs more than the ALB. It cannot be removed — the worker clones arbitrary
GitHub repositories, which is general internet egress that only NAT provides
— but two levers exist if it matters:

- A NAT **instance** on a `t4g.nano` is ~$3/month instead of ~$32, at the
  cost of patching and monitoring it yourself.
- Interface VPC endpoints for ECR/Secrets Manager/Logs cut NAT *data*
  charges but cost ~$7.30/month each per AZ, so four of them cost about what
  the NAT does. Worth it at higher task counts or deploy frequency, not yet.

Only one NAT gateway is created, not one per AZ. Losing its AZ costs
outbound internet for both: the web app keeps serving (its traffic arrives
through the ALB), and the worker's jobs stay queued and drain when egress
returns. That is a deliberate trade against roughly $32/month, reviewable
when there is revenue.

## Operating

```bash
# Why is a task not starting?
aws ecs describe-services --cluster archsetu --services archsetu-web \
  --query 'services[0].events[:5]'

# Logs
aws logs tail /ecs/archsetu/web --follow
aws logs tail /ecs/archsetu/worker --follow

# Roll back to a known-good image
aws ecs update-service --cluster archsetu --service archsetu-web \
  --task-definition archsetu-web:<REVISION>
```

Both services have a deployment circuit breaker with rollback enabled, so a
task that crashes on boot reverts automatically instead of retrying forever
while the deploy reports "in progress".

Terraform `ignore_changes` on `task_definition` and `desired_count` for both
services: CI owns which image is deployed, Terraform owns everything else.
Without it, an unrelated `terraform apply` would silently roll production
back to whatever image was last applied.

## What is deliberately not here

**The database.** Supabase remains the Postgres host. Moving it is phase 4:
269 call sites across 108 files, and the Supabase client's query builder is
not a Postgres client, so it needs either a compatibility shim or a rewrite.
The private subnets and spare CIDR range are laid out to accept an RDS subnet
group when that happens.

Worth knowing why it is still worth doing: RDS in a private subnet has no
PostgREST layer, so the exposure class found in
`supabase/migrations/038_enable_rls_on_all_remaining_tables.sql` — a public
REST API in front of every table, where RLS is the only thing standing
between the internet and your data — stops being possible at all rather than
being correctly configured.

**WAF.** `aws_wafv2_web_acl` on the CloudFront distribution is the obvious
next addition. Left out of this pass so that rate-limit and bot rules are
tuned against real traffic rather than guessed at before cutover.

**Autoscaling.** The web service is fixed at 2 tasks. The worker is fixed at
1 by design and must stay there — the job-claim function hands work to one
consumer at a time, and the memory budget in `analysis.worker.mts` assumes a
single task.
