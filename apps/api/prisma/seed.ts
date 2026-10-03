// Seeds the demo accounts (BF-02): the same emails, passwords and ids as the storefront's mock, so the
// "Development only: fill demo ..." buttons keep working when the storefront talks to the real API.
// Test values for local development only; they are never valid in a real deployment.
import { PrismaPg } from '@prisma/adapter-pg';
import argon2 from 'argon2';
import { config } from 'dotenv';
import { resolve } from 'node:path';
import { PrismaClient } from '../generated/prisma';

config({ path: resolve(import.meta.dirname, '../.env') });

const DEMO = [
  { id: 'usr_demo_customer', name: 'Demo Customer', email: 'demo@shop.test', password: 'Demo@1234', roles: ['customer'] as const },
  { id: 'usr_demo_admin', name: 'Demo Admin', email: 'admin@shop.test', password: 'Admin@1234', roles: ['admin'] as const },
];

async function main(): Promise<void> {
  const url = process.env['DATABASE_URL'];
  if (!url) throw new Error('DATABASE_URL is not set (copy apps/api/.env.example to apps/api/.env)');
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: url }) });
  try {
    for (const account of DEMO) {
      const passwordHash = await argon2.hash(account.password, { type: argon2.argon2id, memoryCost: 19_456, timeCost: 2, parallelism: 1 });
      const data = { name: account.name, email: account.email, roles: [...account.roles], passwordHash, emailVerified: true };
      await db.user.upsert({ where: { email: account.email }, create: { id: account.id, ...data }, update: data });
      console.log(`seeded ${account.email}`);
    }
  } finally {
    await db.$disconnect();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
