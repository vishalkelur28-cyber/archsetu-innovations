# ─────────────────────────────────────────────────────────────────────────
# The analysis worker, as infrastructure-as-code.
#
# This codifies infrastructure that ALREADY EXISTS and was created by hand.
# That is the point: the worker was configured through the console and gcloud,
# which means its real shape lived only in one person's memory and in
# after-the-fact comments in analysis.worker.mts. Nothing could review a
# change to it, nothing could recreate it if the project were lost, and
# nothing could tell you whether the running service still matched what the
# code assumed.
#
# Adopt it rather than duplicate it - `terraform import` the existing service
# before the first apply (see README.md), otherwise this creates a second
# worker competing for the same job queue.
# ─────────────────────────────────────────────────────────────────────────

# ── Container registry ───────────────────────────────────────────────────
resource "google_artifact_registry_repository" "worker" {
  location      = var.region
  repository_id = "archsetu"
  format        = "DOCKER"
  description   = "Images for the ArchSetu analysis worker (built from Dockerfile.worker)."
}

# ── Runtime identity ─────────────────────────────────────────────────────
#
# A dedicated service account, not the default compute service account.
# The default SA carries broad project-level Editor permissions on most
# projects - a worker whose entire job is cloning arbitrary third-party
# repositories and forking a child to parse them is the last workload that
# should inherit them. This one is granted nothing beyond what it needs
# below, so a compromise of the worker is contained to the worker.
resource "google_service_account" "worker" {
  account_id   = "archsetu-worker"
  display_name = "ArchSetu analysis worker"
  description  = "Runtime identity for the Cloud Run analysis worker. Intentionally minimal: it reads one secret and writes logs."
}

# ── Secrets ──────────────────────────────────────────────────────────────
#
# The Supabase service-role key bypasses RLS entirely (see
# supabase/migrations/038), so it is the highest-value credential the worker
# holds. It is stored in Secret Manager and injected as a secret reference,
# NOT as a plain env var in the service definition: a plain value would be
# readable by anyone with view access to the Cloud Run service, would appear
# in `gcloud run services describe` output, and would be captured in
# Terraform state as cleartext.
#
# The secret VALUE is never in this repository. Terraform manages the
# container; the version is written out of band (see README.md).
resource "google_secret_manager_secret" "supabase_service_role_key" {
  secret_id = "archsetu-supabase-service-role-key"

  replication {
    auto {}
  }
}

resource "google_secret_manager_secret_iam_member" "worker_reads_key" {
  secret_id = google_secret_manager_secret.supabase_service_role_key.id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.worker.email}"
}

# ── The worker service ───────────────────────────────────────────────────
resource "google_cloud_run_v2_service" "worker" {
  name     = var.service_name
  location = var.region

  # No public ingress. The worker pulls jobs from the queue; nothing calls
  # into it. The HTTP listener in analysis.worker.mts exists only because
  # Cloud Run services require a port to answer startup probes on - it is a
  # health check, not an API, and must not be reachable from the internet.
  ingress = "INGRESS_TRAFFIC_INTERNAL_ONLY"

  template {
    service_account = google_service_account.worker.email

    # Exactly one instance, always on.
    #
    # min=1 because scale-to-zero is wrong for a queue consumer: with no
    # inbound request to wake it, a scaled-to-zero worker simply stops
    # claiming jobs. max=1 because the job-claim function
    # (supabase/migrations/009) hands a job to one worker at a time and the
    # memory budget in analysis.worker.mts is computed for a single instance
    # running CONCURRENCY=2 children - a second instance would double the
    # real memory demand against the same 2GiB.
    scaling {
      min_instance_count = 1
      max_instance_count = 1
    }

    containers {
      image = var.image

      resources {
        limits = {
          cpu    = var.cpu
          memory = var.memory
        }
        # The worker is not request-driven; it does its work between requests.
        # Throttling CPU outside request handling would stall analysis.
        cpu_idle = false
      }

      env {
        name  = "NEXT_PUBLIC_SUPABASE_URL"
        value = var.supabase_url
      }

      env {
        name = "SUPABASE_SERVICE_ROLE_KEY"
        value_source {
          secret_key_ref {
            secret  = google_secret_manager_secret.supabase_service_role_key.secret_id
            version = "latest"
          }
        }
      }

      # Pinned explicitly rather than left to the code's defaults so the
      # budget is visible in the deployment, not only in a source comment.
      env {
        name  = "CHILD_MAX_OLD_SPACE_MB"
        value = "512"
      }

      startup_probe {
        # analysis.worker.mts starts its health listener before connecting to
        # Supabase precisely so this probe passes fast and does not race the
        # first job claim.
        tcp_socket { port = 8080 }
        initial_delay_seconds = 5
        period_seconds        = 5
        failure_threshold     = 6
      }
    }

    # A clone plus a full parse of a large repository is minutes of work, and
    # the worker's own hard timeout is what is meant to end a runaway job -
    # not the platform cutting the container off underneath it.
    timeout = "3600s"
  }

  # Traffic follows the newest revision. Safe here because there is exactly
  # one instance of a background consumer: there is no user-facing request
  # path to split, and a bad revision is reverted by re-applying the previous
  # pinned image rather than by shifting traffic percentages.
  traffic {
    type    = "TRAFFIC_TARGET_ALLOCATION_TYPE_LATEST"
    percent = 100
  }

  depends_on = [google_secret_manager_secret_iam_member.worker_reads_key]
}
