# workload/state-heavy/main.tf
# Synthetic load profile — creates NO real infrastructure. Uses only the
# hashicorp null / random / time / local providers (must be in the air-gapped
# TFE provider mirror). Keep all variable values FIXED across concurrency stages
# so that concurrency is the only controlled variable.
#
# What it exercises:
#   - time_sleep  : deterministic run duration (holds an agent pod for a known time)
#   - random_pet  : resource-graph churn -> plan/apply CPU + larger state
#   - local_file  : file writes + content embedded in state -> object storage + state
#   - null_resource/local-exec (optional): CPU/disk inside the agent pod
#
# Build + publish (example):
#   tar -czf state-heavy-v1.tar.gz -C workload/state-heavy .
#   curl -fSL -H "Authorization: Bearer $ARTIFACTORY_TOKEN" \
#        -T state-heavy-v1.tar.gz \
#        https://artifactory.example.internal/tfe-loadtest/state-heavy-v1.tar.gz

terraform {
  required_version = ">= 1.6.0"
  required_providers {
    null   = { source = "hashicorp/null" }
    random = { source = "hashicorp/random" }
    time   = { source = "hashicorp/time" }
    local  = { source = "hashicorp/local" }
  }
}

variable "resource_count" {
  description = "Number of synthetic resources -> fakes resource-graph / state size."
  type        = number
  default     = 50
}

variable "file_count" {
  description = "Number of local files -> fakes object-storage + state write load."
  type        = number
  default     = 10
}

variable "file_bytes" {
  description = "Size of each local file in bytes (embedded in state)."
  type        = number
  default     = 4096
}

variable "sleep_seconds" {
  description = "Deterministic floor duration per run."
  type        = number
  default     = 30
}

variable "enable_local_exec" {
  description = "Set false if provisioners are disabled in your TFE run environment."
  type        = bool
  default     = false
}

# 1) Deterministic duration: every run holds an agent pod for ~sleep_seconds.
resource "time_sleep" "dwell" {
  create_duration = "${var.sleep_seconds}s"
}

# 2) Resource-graph churn: inflates the graph and state without touching anything.
resource "random_pet" "r" {
  count  = var.resource_count
  length = 3
}

# 3) State + object-storage pressure: file content is stored in Terraform state.
resource "local_file" "f" {
  count    = var.file_count
  filename = "${path.module}/out/f-${count.index}.txt"
  content  = join("", [for _ in range(floor(var.file_bytes / 16)) : "0123456789abcdef"])
}

# 4) Optional CPU/disk inside the agent pod. triggers=timestamp() forces work on
#    every apply. Requires local-exec provisioners to be permitted.
resource "null_resource" "work" {
  count    = var.enable_local_exec ? var.resource_count : 0
  triggers = { every = timestamp() }

  provisioner "local-exec" {
    command = "dd if=/dev/zero of=${path.module}/blob bs=1M count=16 >/dev/null 2>&1; sleep 1"
  }
}

output "resource_count" {
  value = var.resource_count
}
