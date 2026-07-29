terraform {
  backend "s3" {
    bucket                      = "arbinet-tfstate"
    key                         = "arbinet/prod/terraform.tfstate"
    region                      = "eu-central-1" # placeholder; Hetzner OS ignores AWS region semantics
    endpoints                   = { s3 = "https://nbg1.your-objectstorage.com" }
    use_lockfile                = true # native .tflock object — replaces DynamoDB (G9)
    skip_credentials_validation = true
    skip_region_validation      = true
    skip_requesting_account_id  = true
    skip_s3_checksum            = true # Hetzner OS compatibility
  }
}
