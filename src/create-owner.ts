import 'dotenv/config';
import { hash } from 'argon2';
import { PrismaPg } from '@prisma/adapter-pg';
import { AdminRole, PrismaClient } from './generated/prisma/client';
async function main() {
  const connectionString = process.env.DATABASE_URL,
    email = process.env.ADMIN_BOOTSTRAP_EMAIL?.trim().toLowerCase(),
    name = process.env.ADMIN_BOOTSTRAP_NAME?.trim(),
    password = process.env.ADMIN_BOOTSTRAP_PASSWORD;
  if (!connectionString || !email || !name || !password)
    throw new Error(
      'Укажите DATABASE_URL, ADMIN_BOOTSTRAP_EMAIL, ADMIN_BOOTSTRAP_NAME и ADMIN_BOOTSTRAP_PASSWORD',
    );
  if (password.length < 8)
    throw new Error('Пароль должен содержать минимум 8 символов');
  const prisma = new PrismaClient({
    adapter: new PrismaPg({ connectionString }),
  });
  try {
    if (await prisma.adminUser.count())
      throw new Error(
        'Bootstrap доступен только когда таблица AdminUser пуста',
      );
    const user = await prisma.adminUser.create({
      data: {
        email,
        name,
        role: AdminRole.OWNER,
        passwordHash: await hash(password),
        mustChangePassword: false,
        passwordChangedAt: new Date(),
      },
      select: { email: true },
    });
    console.log(`OWNER создан: ${user.email}`);
  } finally {
    await prisma.$disconnect();
  }
}
main().catch((error) => {
  console.error(
    error instanceof Error ? error.message : 'Не удалось создать OWNER',
  );
  process.exit(1);
});
