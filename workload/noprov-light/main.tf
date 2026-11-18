# workload/noprov-light/main.tf
# NO-PROVIDER baseline profile. Uses ONLY terraform_data (built-in), so a run
# downloads NO providers from the mirror. Run this through the same short ladder
# as a provider-using profile: if noprov-light scales but the others don't, the
# provider mirror (Artifactory), not TFE, is the first bottleneck.
#
# Build:  tar -czf noprov-light-v1.tar.gz -C workload/noprov-light .

terraform {
  required_version = ">= 1.6.0, < 2.0.0"
  # No required_providers block: terraform_data is built-in.
}

variable "profile" { default = "noprov-light-v1" }
variable "mock_count" { default = 5 }
variable "nonce" { default = "" }

locals {
  ids = toset([for i in range(var.mock_count) : format("n-%04d", i)])
}

resource "terraform_data" "anchor" {
  input = { profile = var.profile, nonce = var.nonce }
}

resource "terraform_data" "mock" {
  for_each = local.ids
  input    = { id = each.key, net = terraform_data.anchor.id, nonce = var.nonce }
}

output "mock_count" { value = length(local.ids) }
