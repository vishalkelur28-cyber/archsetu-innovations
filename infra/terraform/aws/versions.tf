terraform {
  required_version = ">= 1.6.0"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.60"
    }
    random = {
      source  = "hashicorp/random"
      version = "~> 3.6"
    }
  }

  # Configure before a second person ever runs `apply`. Local state is
  # unversioned, unlocked and owned by one machine; two concurrent applies
  # against it will corrupt each other with no warning.
  #
  # backend "s3" {
  #   bucket       = "archsetu-tfstate"
  #   key          = "aws/terraform.tfstate"
  #   region       = "ap-south-1"
  #   encrypt      = true
  #   use_lockfile = true   # S3-native locking, no DynamoDB table needed
  # }
}

provider "aws" {
  region = var.region

  default_tags {
    tags = {
      Project   = "archsetu"
      ManagedBy = "terraform"
      Source    = "infra/terraform/aws"
    }
  }
}

# CloudFront only accepts ACM certificates issued in us-east-1, regardless of
# where everything else lives. This aliased provider exists solely for that.
provider "aws" {
  alias  = "us_east_1"
  region = "us-east-1"

  default_tags {
    tags = {
      Project   = "archsetu"
      ManagedBy = "terraform"
      Source    = "infra/terraform/aws"
    }
  }
}
