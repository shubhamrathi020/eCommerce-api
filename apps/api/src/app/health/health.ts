import { Controller, Get, HttpCode, Inject, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import { SkipThrottle } from '@nestjs/throttler';
import { MailService, type OutboxMail } from '../auth/mail.service';
import { RedisService } from '../cache/redis.service';
import { MongoService } from '../catalog/mongo.service';
import { SearchService } from '../catalog/search.service';
import { API_CONFIG, type ApiConfig } from '../config';
import { RabbitService } from '../messaging/rabbit.service';
import { PrismaService } from '../prisma/prisma.service';

/** Liveness and readiness for Docker and Kubernetes probes (BF-06). Same paths as the storefront server. */
@ApiExcludeController()
@SkipThrottle()
@Controller()
export class HealthController {
  constructor(
    private readonly db: PrismaService,
    private readonly mongo: MongoService,
    private readonly search: SearchService,
    private readonly redis: RedisService,
    private readonly rabbit: RabbitService,
  ) {}

  /** The process is up. Never touches dependencies, so an outage does not restart every pod. */
  @Get('healthz')
  @HttpCode(200)
  healthz(): string {
    return 'ok';
  }

  /** Ready for traffic only when every store the API depends on answers. */
  @Get('readyz')
  async readyz(): Promise<string> {
    try {
      await Promise.all([this.db.$queryRaw`SELECT 1`, this.mongo.ping(), this.search.health(), this.redis.ping(), this.rabbit.ping()]);
      return 'ok';
    } catch {
      throw new ServiceUnavailableException('a dependency is unavailable');
    }
  }
}

/** Development only: the mails the API would have sent (verification and reset links). 404 in production. */
@ApiExcludeController()
@Controller('dev')
export class DevOutboxController {
  constructor(
    private readonly mail: MailService,
    @Inject(API_CONFIG) private readonly config: ApiConfig,
  ) {}

  @Get('outbox')
  outbox(): OutboxMail[] {
    if (this.config.production) throw new NotFoundException();
    return this.mail.list();
  }
}
