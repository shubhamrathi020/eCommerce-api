import { Inject, Injectable, OnModuleDestroy } from '@nestjs/common';
import { PrismaPg } from '@prisma/adapter-pg';
// The generated client (gitignored, so invisible to Nx's dependency scan) needs this at runtime; importing it
// here puts it in the pruned production package.json that the Docker image installs.
import '@prisma/client-runtime-utils';
import { PrismaClient } from '../../../generated/prisma';
import { API_CONFIG, type ApiConfig } from '../config';

/** The one database client for the app (Prisma 7 connects through a driver adapter, not a URL in the schema). */
@Injectable()
export class PrismaService extends PrismaClient implements OnModuleDestroy {
  constructor(@Inject(API_CONFIG) config: ApiConfig) {
    super({ adapter: new PrismaPg({ connectionString: config.databaseUrl }) });
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
  }
}
