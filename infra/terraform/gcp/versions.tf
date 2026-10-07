terraform {
  required_version = ">= 1.6.0"

  required_providers {
    google = {
      source  = "hashicorp/google"
      version = "~> 6.0"
    }
  }

  # State is deliberately NOT left on a laptop.
  #
  # Uncomment and point this at a bucket before the first `terraform apply`
  # that anyone else will also run. Terraform state contains resource
  # metadata and, for some resource types, secret material - it belongs in a
  # versioned, access-controlled bucket with state locking, not in a local
  # terraform.tfstate that one machine owns and that nothing backs up.
  #
  # backend "gcs" {
  #   bucket = "archsetu-tfstate"
  #   prefix = "worker"
  # }
}

provider "google" {
  project = var.project_id
  region  = var.region
}
