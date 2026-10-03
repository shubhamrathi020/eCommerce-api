# Cloud infrastructure as code for AWS (BRD 25, K8-05).
#
# STATUS: WRITTEN BUT NEVER APPLIED. No cloud account exists in this environment and `terraform` is not
# installed on this machine, so this has not even been through `terraform validate`. Treat it as a reviewed
# starting point, not a verified deployment: the acceptance criterion "staging created and destroyed from
# code" is NOT met until someone runs `terraform init && terraform apply` / `destroy` against a real
# account and fixes whatever that turns up. Provider and module versions below are pinned to ranges that
# existed when this was written; check them first.
#
# Shape: managed services replace the in-cluster stand-ins used locally (deploy/k8s) — RDS for Postgres,
# ElastiCache for Redis — while Mongo, RabbitMQ and Meilisearch stay in the cluster as Deployments
# (managed equivalents DocumentDB / Amazon MQ / OpenSearch behave differently enough from the real thing
# that swapping them is its own piece of work, and DocumentDB in particular is not full MongoDB).

terraform {
  required_version = ">= 1.6"
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
  }
  # Remote state is required for a team and for `destroy` to be safe; fill in a real bucket first.
  # backend "s3" {
  #   bucket         = "REPLACE-ME-tfstate"
  #   key            = "ecommerce/${var.environment}.tfstate"
  #   region         = "ap-south-1"
  #   dynamodb_table = "REPLACE-ME-tflock"
  # }
}

provider "aws" {
  region = var.region
  default_tags {
    tags = { project = "ecommerce", environment = var.environment, managed_by = "terraform" }
  }
}

data "aws_availability_zones" "available" {}

module "vpc" {
  source  = "terraform-aws-modules/vpc/aws"
  version = "~> 5.0"

  name = "ecommerce-${var.environment}"
  cidr = "10.20.0.0/16"
  azs  = slice(data.aws_availability_zones.available.names, 0, 2)

  private_subnets = ["10.20.1.0/24", "10.20.2.0/24"]
  public_subnets  = ["10.20.101.0/24", "10.20.102.0/24"]

  enable_nat_gateway = true
  # One NAT gateway keeps staging cheap; production should set this false (one per AZ) — see docs/CAPACITY-PLAN.md.
  single_nat_gateway = var.environment != "production"
}

module "eks" {
  source  = "terraform-aws-modules/eks/aws"
  version = "~> 20.0"

  cluster_name    = "ecommerce-${var.environment}"
  cluster_version = "1.31"
  vpc_id          = module.vpc.vpc_id
  subnet_ids      = module.vpc.private_subnets

  cluster_endpoint_public_access = true

  eks_managed_node_groups = {
    default = {
      instance_types = [var.node_instance_type]
      min_size       = var.node_min
      max_size       = var.node_max
      desired_size   = var.node_min
    }
  }
}

# --- PostgreSQL (replaces deploy/k8s/data-tier/postgres.yaml) ---
resource "aws_db_subnet_group" "db" {
  name       = "ecommerce-${var.environment}"
  subnet_ids = module.vpc.private_subnets
}

resource "aws_security_group" "data" {
  name_prefix = "ecommerce-data-"
  vpc_id      = module.vpc.vpc_id

  # Only the EKS nodes may reach the databases — the cloud counterpart of deploy/k8s's NetworkPolicies.
  ingress {
    from_port       = 5432
    to_port         = 5432
    protocol        = "tcp"
    security_groups = [module.eks.node_security_group_id]
  }
  ingress {
    from_port       = 6379
    to_port         = 6379
    protocol        = "tcp"
    security_groups = [module.eks.node_security_group_id]
  }
}

resource "aws_db_instance" "postgres" {
  identifier        = "ecommerce-${var.environment}"
  engine            = "postgres"
  engine_version    = "17"
  instance_class    = var.db_instance_class
  allocated_storage = 20

  db_name  = "ecommerce"
  username = "ecommerce"
  # The password is generated and stored by RDS in Secrets Manager — it never appears in this repo or in state.
  manage_master_user_password = true

  db_subnet_group_name   = aws_db_subnet_group.db.name
  vpc_security_group_ids = [aws_security_group.data.id]

  multi_az                = var.environment == "production"
  storage_encrypted       = true
  # 7 days of point-in-time recovery is what makes BRD 24's RPO of 15 minutes achievable in the cloud.
  backup_retention_period = 7
  deletion_protection     = var.environment == "production"
  skip_final_snapshot     = var.environment != "production"
}

# --- Redis (replaces deploy/k8s/base/redis.yaml) ---
resource "aws_elasticache_subnet_group" "redis" {
  name       = "ecommerce-${var.environment}"
  subnet_ids = module.vpc.private_subnets
}

resource "aws_elasticache_cluster" "redis" {
  cluster_id           = "ecommerce-${var.environment}"
  engine               = "redis"
  node_type            = var.redis_node_type
  num_cache_nodes      = 1
  port                 = 6379
  subnet_group_name    = aws_elasticache_subnet_group.redis.name
  security_group_ids   = [aws_security_group.data.id]
}
