output "service_uri" {
  description = "Cloud Run URI of the worker. Internal-ingress only - useful for gcloud/log queries, not reachable from the internet."
  value       = google_cloud_run_v2_service.worker.uri
}

output "service_account_email" {
  description = "Runtime identity of the worker. Grant any future GCP permission to this, never to the default compute service account."
  value       = google_service_account.worker.email
}

output "image_repository" {
  description = "Artifact Registry path to push worker images to."
  value       = "${var.region}-docker.pkg.dev/${var.project_id}/${google_artifact_registry_repository.worker.repository_id}"
}
