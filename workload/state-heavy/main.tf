# workload/state-heavy/main.tf
# Synthetic, DETERMINISTIC load. Creates no real infrastructure. Variance in the
# results must come from TFE and the infrastructure, NOT from the workload — so
# nothing here is random or time-based except one explicit, constant hold.
#
# CHANGED (v2 review): removed random_pet and `triggers = timestamp()` (both
# non-deterministic and random_pet pulled in an extra provider). Now built on
# terraform_data (BUILT-IN, no provider download) + local_file + time_sleep, and
# a `nonce` run-variable drives changes in reuse mode instead of timestamp().
#
# Providers:
#   - terraform_data : built-in (terraform.io/builtin/terraform), NO mirror fetch.
#     A hold-only / terraform_data-only profile isolates whether the provider
#     mirror is the first bottleneck (see profile catalog in the design doc).
#   - local, time    : only these two; both must exist in the air-gapped mirror.

terraform {
  required_version = ">= 1.6.0, < 2.0.0" # match the workspace's pinned version
  required_providers {
    local = { source = "hashicorp/local", version = "= 2.5.1" } # pin to your mirror
    time  = { source = "hashicorp/time", version = "= 0.12.1" }  # pin to your mirror
  }
}

variable "profile" { default = "state-heavy-v1" }
variable "mock_count" { default = 50 } # mock VMs -> plan + state size
variable "payload_kb" { default = 100 } # bytes per mock VM -> state + object storage
variable "hold_seconds" { default = 30 } # constant hold -> run overlap (deterministic)
variable "nonce" { default = "" } # set ONLY when reuseWs=true, to force changes

locals {
  ids     = toset([for i in range(var.mock_count) : format("vm-%04d", i)])
  chunk   = join("", [for _ in range(64) : "0123456789abcde\n"]) # 1 KiB
  payload = join("", [for _ in range(var.payload_kb) : local.chunk])
}

# Tier 1 — built-in, no provider download. Anchors the dependency graph.
resource "terraform_data" "network" {
  input = { profile = var.profile, nonce = var.nonce }
}

# Tier 2 — mock VMs: file writes + content embedded in state (object storage + Postgres).
resource "local_file" "mock_vm" {
  for_each = local.ids
  filename = "${path.module}/out/${each.key}.json"
  content = jsonencode({
    id    = each.key
    net   = terraform_data.network.id
    nonce = var.nonce
    data  = local.payload
  })
}

# Tier 3 — constant hold so N runs overlap. Deterministic duration, no timestamp().
resource "time_sleep" "hold" {
  count           = var.hold_seconds > 0 ? 1 : 0
  create_duration = "${var.hold_seconds}s"
  triggers        = { nonce = var.nonce }
  depends_on      = [local_file.mock_vm]
}

output "mock_vms" { value = length(local.ids) }
