variable "environment" {
  description = "staging or production — drives HA settings (Multi-AZ, NAT per AZ, deletion protection)"
  type        = string
  default     = "staging"
  validation {
    condition     = contains(["staging", "production"], var.environment)
    error_message = "environment must be staging or production."
  }
}

variable "region" {
  description = "AWS region. ap-south-1 (Mumbai) is the default because the shop serves Indian pin codes and INR; the cloud choice itself is still an open question in BRD 25 section 8."
  type        = string
  default     = "ap-south-1"
}

variable "node_instance_type" {
  type    = string
  default = "t3.large"
}

variable "node_min" {
  type    = number
  default = 2
}

variable "node_max" {
  type    = number
  default = 6
}

variable "db_instance_class" {
  type    = string
  default = "db.t4g.medium"
}

variable "redis_node_type" {
  type    = string
  default = "cache.t4g.small"
}
