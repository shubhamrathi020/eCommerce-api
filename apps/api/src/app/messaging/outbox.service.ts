import { Injectable } from '@nestjs/common';
import type { Prisma } from '../../../generated/prisma';
import { PrismaService } from '../prisma/prisma.service';

/** Writes one outbox row (BRD 23, MQ-02). Callers pass the same Prisma transaction client (`tx`) they
 * used for the domain write itself — `db.$transaction(async (tx) => { ...write the order...; await
 * outbox.write(tx, 'order.placed', {...}); })` — so the two either both commit or both roll back. There
 * is no separate `write(routingKey, payload)` overload on the plain client: an event with no matching
 * domain write would be exactly the "fired without the write happening" bug this pattern exists to rule out. */
@Injectable()
export class OutboxService {
  constructor(private readonly db: PrismaService) {}

  async write(tx: Prisma.TransactionClient, routingKey: string, payload: unknown): Promise<void> {
    await tx.outboxEvent.create({ data: { routingKey, payload: payload as Prisma.InputJsonValue } });
  }

  /** For callers that are not already inside a transaction of their own (the scheduler's jobs) — still
   * one write, just not paired with another write to be atomic with. */
  async writeStandalone(routingKey: string, payload: unknown): Promise<void> {
    await this.db.outboxEvent.create({ data: { routingKey, payload: payload as Prisma.InputJsonValue } });
  }
}
