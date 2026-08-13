const { PrismaPg } = require('@prisma/adapter-pg');
const { hash } = require('argon2');
const { AdminRole, PrismaClient } = require('../dist/generated/prisma/client');

async function main() {
  const { DATABASE_URL, SMOKE_EMAIL, SMOKE_PASSWORD, SMOKE_ACTION } = process.env;
  if (!DATABASE_URL || !SMOKE_EMAIL) throw new Error('Missing smoke configuration');
  const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: DATABASE_URL }) });
  try {
    if (SMOKE_ACTION === 'delete') {
      await prisma.adminUser.deleteMany({ where: { email: SMOKE_EMAIL } });
      return;
    }
    if (!SMOKE_PASSWORD) throw new Error('Missing smoke password');
    await prisma.adminUser.create({
      data: {
        email: SMOKE_EMAIL,
        name: 'Production Smoke',
        role: AdminRole.OWNER,
        passwordHash: await hash(SMOKE_PASSWORD),
        mustChangePassword: false,
      },
    });
  } finally {
    await prisma.$disconnect();
  }
}

void main().catch(() => {
  process.exitCode = 1;
});
