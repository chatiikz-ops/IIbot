import 'dotenv/config';
import { PrismaPg } from '@prisma/adapter-pg';
import { hash } from 'argon2';
import { PrismaClient } from './generated/prisma/client';

const MIN_PASSWORD_LENGTH = 8;

async function main(): Promise<void> {
  const connectionString = process.env.DATABASE_URL;
  const email = process.env.ADMIN_RESET_EMAIL?.trim().toLowerCase();
  const password = process.env.ADMIN_RESET_PASSWORD;

  if (!connectionString) {
    throw new Error('Не указан DATABASE_URL');
  }
  if (!email) {
    throw new Error('Не указан ADMIN_RESET_EMAIL');
  }
  if (!password) {
    throw new Error('Не указан ADMIN_RESET_PASSWORD');
  }
  if (password.length < MIN_PASSWORD_LENGTH) {
    throw new Error('Пароль должен содержать минимум 8 символов');
  }

  const prisma = new PrismaClient({
    adapter: new PrismaPg({ connectionString }),
  });

  try {
    const user = await prisma.adminUser.findUnique({
      where: { email },
      select: { id: true },
    });
    if (!user) {
      throw new Error('Пользователь с таким email не найден');
    }

    const passwordHash = await hash(password);
    const changedAt = new Date();
    await prisma.$transaction([
      prisma.adminUser.update({
        where: { id: user.id },
        data: {
          passwordHash,
          passwordChangedAt: changedAt,
          mustChangePassword: false,
        },
      }),
      prisma.adminSession.updateMany({
        where: { userId: user.id, revokedAt: null },
        data: { revokedAt: changedAt },
      }),
    ]);

    console.log('Пароль пользователя успешно изменён');
  } finally {
    await prisma.$disconnect();
  }
}

void main().catch((error: unknown) => {
  console.error(
    error instanceof Error ? error.message : 'Не удалось изменить пароль',
  );
  process.exitCode = 1;
});
