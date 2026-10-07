# Kubernetes — the analysis worker, hardened

The same container that runs on Cloud Run today, expressed as a Kubernetes
workload with the security controls a workload like this actually needs.

## Why the worker, and not the web app

The worker's entire job is cloning arbitrary third-party git repositories and
forking a child process to parse them. It executes against untrusted input by
design, which makes it the most security-sensitive thing in this system and
the one where each restriction below has a concrete reason rather than a
checklist entry.

It is also the safest thing to move: it is a queue consumer, so nothing calls
it, there is no DNS cutover, and no user notices if it restarts.

## Run it locally

Needs Docker and [kind](https://kind.sigs.k8s.io/).

```bash
kind create cluster --name archsetu

kubectl apply -f namespace.yaml
kubectl apply -f networkpolicy.yaml

# Real values, never committed. See secret.example.yaml.
kubectl -n archsetu create secret generic archsetu-worker \
  --from-literal=NEXT_PUBLIC_SUPABASE_URL='https://xxxx.supabase.co' \
  --from-literal=SUPABASE_SERVICE_ROLE_KEY='...'

# Build and load the image, since kind has no registry access by default.
docker build -f ../../Dockerfile.worker -t archsetu/worker:dev ../..
kind load docker-image archsetu/worker:dev --name archsetu

sed 's|ghcr.io/archsetu/worker:REPLACE_ME|archsetu/worker:dev|' worker.yaml | kubectl apply -f -
kubectl -n archsetu rollout status deploy/archsetu-worker
kubectl -n archsetu logs -f -l app.kubernetes.io/name=archsetu-worker
```

## What is enforced, and why

| Control | Reason |
|---|---|
| `restricted` Pod Security Standard on the namespace | Enforced by the API server for *every* pod created here, not just the one written correctly. This is the guarantee; the Deployment's own settings are the intent. |
| `runAsNonRoot`, uid 1000 | Matches the `node` user in `Dockerfile.worker`. A parser running untrusted code should never be root. |
| `readOnlyRootFilesystem` | A parser exploit cannot modify the application it is running inside. `/tmp` is a bounded `emptyDir` because `git clone` has to write somewhere. |
| `capabilities: drop: [ALL]` | Not "drop the dangerous ones" — drop everything. This process binds a high port, reads files, makes HTTPS calls. It needs no capability. |
| `allowPrivilegeEscalation: false` | Blocks setuid binaries from regaining what the line above dropped. |
| `seccompProfile: RuntimeDefault` | Blocks the syscalls where most container-escape primitives live. |
| `automountServiceAccountToken: false` | The worker never calls the Kubernetes API. A token it does not use is a credential handed to a process parsing untrusted code. |
| Default-deny NetworkPolicy | Kubernetes has **no** network isolation by default. Written as deny-then-allow so it fails closed. |
| Egress `except` private ranges | Blocks `169.254.169.254` — the cloud metadata endpoint, the standard SSRF target for stealing node IAM credentials — and the whole internal cluster network. The worker reaches GitHub and nothing on the inside. |
| `requests == limits` for memory | Guaranteed QoS, so it is evicted last. Eviction mid-analysis means requeue and re-clone from scratch. |
| CPU request, no CPU limit | Limits throttle rather than kill. Throttling a parser turns a 40-second analysis into minutes for no benefit. |
| `replicas: 1`, `strategy: Recreate` | The job-claim function hands work to one consumer at a time, and the memory budget in `analysis.worker.mts` assumes a single pod. A rolling update would briefly run two. |

## This is verified, not assumed

`.github/workflows/kubernetes.yml` does not stop at linting. It creates a real
kind cluster, applies these manifests, and then:

- reads the **live pod object** back and asserts each security field actually
  took effect — a manifest that *says* `runAsNonRoot` proves nothing about
  what the API server admitted;
- **attempts to create a privileged pod** and fails the build if it is
  accepted. A policy that has never refused anything has not been shown to
  work;
- asserts the default-deny NetworkPolicy selects every pod for both
  directions.

That shape is deliberate. Earlier in this repository, `Dockerfile.web` was
written, reviewed and committed without ever being built, then took five CI
rounds to make work. Infrastructure that has never been applied is a guess
with good syntax.

## Not done, on purpose

- **No Secrets Operator.** Kubernetes Secrets are base64, not encrypted —
  anyone with `get secret` or etcd access reads them. For anything beyond a
  local cluster, back this with External Secrets Operator pointing at the AWS
  Secrets Manager entries `infra/terraform/aws/secrets.tf` already creates, so
  the value lives in one place with one audit trail.
- **No HPA.** Scaling this workload is incorrect, not unimplemented — see the
  `replicas: 1` reasoning above.
- **No Ingress / Service.** Nothing calls the worker. The port exists only for
  the kubelet's probe.
- **No cluster provisioning.** `infra/terraform/aws` provisions ECS Fargate,
  which is what actually runs this today. These manifests are the portable
  form of the same workload; an EKS module would be the next step if the
  cluster ever became the target.
