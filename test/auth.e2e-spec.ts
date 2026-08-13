/* eslint-disable @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-return */
import { ValidationPipe } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Test } from '@nestjs/testing';
import { hash } from 'argon2';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import type { INestApplication } from '@nestjs/common';
import { AppModule } from '../src/app.module';
import { AdminRole } from '../src/generated/prisma/enums';
import { PrismaService } from '../src/prisma/prisma.service';

describe('Admin auth regression (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let jwt: JwtService;
  const marker = `auth-e2e-${Date.now()}`;
  const ownerEmail = `${marker}@example.com`;
  const backupEmail = `${marker}-backup@example.com`;
  const password = 'OwnerPassword!123';
  let ownerId: string;
  let backupId: string;
  let access = '';
  let cookie = '';
  let loginCounter = 10;

  const cookieValue = (response: request.Response) => {
    const values = response.headers['set-cookie'] as unknown as string[];
    return values?.[0]?.split(';')[0] ?? '';
  };
  const login = (email = ownerEmail, pass = password) =>
    request(app.getHttpServer())
      .post('/auth/login')
      .set('X-Forwarded-For', `127.0.0.${loginCounter++}`)
      .send({ email, password: pass });
  const bearer = (token = access) => ({ Authorization: `Bearer ${token}` });

  beforeAll(async () => {
    process.env.NODE_ENV = 'test';
    process.env.AUTOMATION_WORKER_ENABLED = 'false';
    const module = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = module.createNestApplication();
    app.getHttpAdapter().getInstance().set('trust proxy', true);
    app.use(cookieParser());
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        transform: true,
        forbidNonWhitelisted: true,
      }),
    );
    await app.init();
    prisma = app.get(PrismaService);
    jwt = app.get(JwtService);
    const passwordHash = await hash(password);
    const [owner, backup] = await Promise.all([
      prisma.adminUser.create({
        data: {
          email: ownerEmail,
          name: 'Auth Owner',
          role: AdminRole.OWNER,
          passwordHash,
          mustChangePassword: false,
        },
      }),
      prisma.adminUser.create({
        data: {
          email: backupEmail,
          name: 'Backup Owner',
          role: AdminRole.OWNER,
          passwordHash,
          mustChangePassword: false,
        },
      }),
    ]);
    ownerId = owner.id;
    backupId = backup.id;
  });

  afterAll(async () => {
    await prisma.adminUser.deleteMany({
      where: { email: { startsWith: marker } },
    });
    await app.close();
  });

  it('1 OWNER login succeeds', async () => {
    const response = await login().expect(200);
    access = response.body.accessToken as string;
    cookie = cookieValue(response);
    expect(response.body.user.role).toBe('OWNER');
  });
  it('2 wrong password is 401', () => login(ownerEmail, 'wrong').expect(401));
  it('3 unknown email returns the same 401 contract', async () => {
    const wrong = await login(ownerEmail, 'wrong');
    const unknown = await login(`${marker}-unknown@example.com`, 'wrong');
    expect(unknown.status).toBe(401);
    expect(unknown.body.message).toBe(wrong.body.message);
  });
  it('4 inactive user cannot login', async () => {
    await prisma.adminUser.update({
      where: { id: backupId },
      data: { isActive: false },
    });
    await login(backupEmail).expect(401);
    await prisma.adminUser.update({
      where: { id: backupId },
      data: { isActive: true },
    });
  });
  it('5 missing access token is 401', () =>
    request(app.getHttpServer()).get('/contacts').expect(401));
  it('6 valid access token works', () =>
    request(app.getHttpServer()).get('/auth/me').set(bearer()).expect(200));
  it('7 malformed access token is 401', () =>
    request(app.getHttpServer())
      .get('/auth/me')
      .set(bearer('broken'))
      .expect(401));
  it('8 expired access token is 401', async () => {
    const sessionId = (
      await prisma.adminSession.findFirstOrThrow({
        where: { userId: ownerId, revokedAt: null },
        orderBy: { createdAt: 'desc' },
      })
    ).id;
    const expired = await jwt.signAsync(
      { sub: ownerId, email: ownerEmail, role: AdminRole.OWNER, sessionId },
      { expiresIn: -1 },
    );
    await request(app.getHttpServer())
      .get('/auth/me')
      .set(bearer(expired))
      .expect(401);
  });
  it('9 refresh succeeds', async () => {
    const response = await request(app.getHttpServer())
      .post('/auth/refresh')
      .set('Cookie', cookie)
      .expect(201);
    cookie = cookieValue(response);
  });
  it('10 refresh rotates the cookie', async () => {
    const response = await request(app.getHttpServer())
      .post('/auth/refresh')
      .set('Cookie', cookie)
      .expect(201);
    expect(cookieValue(response)).not.toBe(cookie);
    cookie = cookieValue(response);
  });
  it('11 concurrent refresh within grace does not revoke session', async () => {
    const original = cookie;
    const responses = await Promise.all([
      request(app.getHttpServer())
        .post('/auth/refresh')
        .set('Cookie', original),
      request(app.getHttpServer())
        .post('/auth/refresh')
        .set('Cookie', original),
    ]);
    expect(responses.map((item) => item.status).sort()).toEqual([201, 401]);
    const winner = responses.find((item) => item.status === 201)!;
    cookie = cookieValue(winner);
    await request(app.getHttpServer())
      .post('/auth/refresh')
      .set('Cookie', cookie)
      .expect(201);
  });
  it('12 replay outside grace revokes the session', async () => {
    const fresh = await login();
    const oldCookie = cookieValue(fresh);
    const rotated = await request(app.getHttpServer())
      .post('/auth/refresh')
      .set('Cookie', oldCookie)
      .expect(201);
    const sessionId = oldCookie.split('=')[1].split('.')[0];
    await prisma.adminSession.update({
      where: { id: sessionId },
      data: { previousTokenValidUntil: new Date(0) },
    });
    await request(app.getHttpServer())
      .post('/auth/refresh')
      .set('Cookie', oldCookie)
      .expect(401);
    expect(
      (
        await prisma.adminSession.findUniqueOrThrow({
          where: { id: sessionId },
        })
      ).revokedAt,
    ).not.toBeNull();
    await request(app.getHttpServer())
      .post('/auth/refresh')
      .set('Cookie', cookieValue(rotated))
      .expect(401);
  });
  it('13 revoked session cannot access API', async () => {
    const response = await login();
    const token = response.body.accessToken as string;
    const sessionId = cookieValue(response).split('=')[1].split('.')[0];
    await prisma.adminSession.update({
      where: { id: sessionId },
      data: { revokedAt: new Date() },
    });
    await request(app.getHttpServer())
      .get('/auth/me')
      .set(bearer(token))
      .expect(401);
  });
  it('14 logout revokes current session', async () => {
    const response = await login();
    const sessionCookie = cookieValue(response);
    await request(app.getHttpServer())
      .post('/auth/logout')
      .set(bearer(response.body.accessToken))
      .set('Cookie', sessionCookie)
      .expect(201);
    await request(app.getHttpServer())
      .post('/auth/refresh')
      .set('Cookie', sessionCookie)
      .expect(401);
  });
  it('15 logout-all revokes every session', async () => {
    const first = await login();
    const second = await login();
    await request(app.getHttpServer())
      .post('/auth/logout-all')
      .set(bearer(first.body.accessToken))
      .set('Cookie', cookieValue(first))
      .expect(201);
    await request(app.getHttpServer())
      .post('/auth/refresh')
      .set('Cookie', cookieValue(second))
      .expect(401);
  });
  it('16 blocked user current access stops immediately', async () => {
    const response = await login(backupEmail);
    await prisma.adminUser.update({
      where: { id: backupId },
      data: { isActive: false },
    });
    await request(app.getHttpServer())
      .get('/auth/me')
      .set(bearer(response.body.accessToken))
      .expect(401);
  });
  it('17 blocked user refresh is denied', async () => {
    await prisma.adminUser.update({
      where: { id: backupId },
      data: { isActive: true },
    });
    const response = await login(backupEmail);
    await prisma.adminUser.update({
      where: { id: backupId },
      data: { isActive: false },
    });
    await request(app.getHttpServer())
      .post('/auth/refresh')
      .set('Cookie', cookieValue(response))
      .expect(401);
    await prisma.adminUser.update({
      where: { id: backupId },
      data: { isActive: true },
    });
  });

  let managerId = '';
  let temporaryPassword = '';
  let managerAccess = '';
  const managerEmail = `${marker}-manager@example.com`;
  it('18 OWNER creates MANAGER', async () => {
    const owner = await login();
    access = owner.body.accessToken as string;
    const response = await request(app.getHttpServer())
      .post('/admin-users')
      .set(bearer())
      .send({
        name: 'Auth Manager',
        email: managerEmail,
        role: AdminRole.MANAGER,
      })
      .expect(201);
    managerId = response.body.user.id as string;
    temporaryPassword = response.body.temporaryPassword as string;
  });
  it('19 duplicate email is 409', () =>
    request(app.getHttpServer())
      .post('/admin-users')
      .set(bearer())
      .send({ name: 'Duplicate', email: managerEmail, role: AdminRole.MANAGER })
      .expect(409));
  it('20 temporary password works', async () => {
    const response = await login(managerEmail, temporaryPassword).expect(200);
    managerAccess = response.body.accessToken as string;
    expect(response.body.user.mustChangePassword).toBe(true);
  });
  it('21 mustChangePassword blocks CRM', () =>
    request(app.getHttpServer())
      .get('/contacts')
      .set(bearer(managerAccess))
      .expect(403));
  it('22 /auth/me is allowed before password change', () =>
    request(app.getHttpServer())
      .get('/auth/me')
      .set(bearer(managerAccess))
      .expect(200));
  const managerPassword = 'ManagerPassword!456';
  it('23 change-password succeeds', () =>
    request(app.getHttpServer())
      .post('/auth/change-password')
      .set(bearer(managerAccess))
      .send({
        currentPassword: temporaryPassword,
        newPassword: managerPassword,
      })
      .expect(201));
  it('24 old password is invalid', () =>
    login(managerEmail, temporaryPassword).expect(401));
  it('25 new password is valid', () =>
    login(managerEmail, managerPassword).expect(200));
  it('26 reset-password revokes sessions', async () => {
    const current = await login(managerEmail, managerPassword);
    await request(app.getHttpServer())
      .post(`/admin-users/${managerId}/reset-password`)
      .set(bearer())
      .expect(201);
    await request(app.getHttpServer())
      .get('/auth/me')
      .set(bearer(current.body.accessToken))
      .expect(401);
  });
  it('27 MANAGER cannot call OWNER endpoint', async () => {
    const reset = await request(app.getHttpServer())
      .post(`/admin-users/${managerId}/reset-password`)
      .set(bearer())
      .expect(201);
    const manager = await login(managerEmail, reset.body.temporaryPassword);
    await request(app.getHttpServer())
      .get('/admin-users')
      .set(bearer(manager.body.accessToken))
      .expect(403);
  });
  it('28 last active OWNER cannot be blocked', async () => {
    const otherOwners = await prisma.adminUser.findMany({
      where: { role: AdminRole.OWNER, id: { not: ownerId }, isActive: true },
      select: { id: true },
    });
    await prisma.adminUser.updateMany({
      where: { id: { in: otherOwners.map((item) => item.id) } },
      data: { isActive: false },
    });
    try {
      await request(app.getHttpServer())
        .post(`/admin-users/${ownerId}/block`)
        .set(bearer())
        .expect(409);
    } finally {
      await prisma.adminUser.updateMany({
        where: { id: { in: otherOwners.map((item) => item.id) } },
        data: { isActive: true },
      });
    }
  });
  it('29 last active OWNER cannot be demoted', async () => {
    const otherOwners = await prisma.adminUser.findMany({
      where: { role: AdminRole.OWNER, id: { not: ownerId }, isActive: true },
      select: { id: true },
    });
    await prisma.adminUser.updateMany({
      where: { id: { in: otherOwners.map((item) => item.id) } },
      data: { isActive: false },
    });
    try {
      await request(app.getHttpServer())
        .patch(`/admin-users/${ownerId}`)
        .set(bearer())
        .send({ role: AdminRole.MANAGER })
        .expect(409);
    } finally {
      await prisma.adminUser.updateMany({
        where: { id: { in: otherOwners.map((item) => item.id) } },
        data: { isActive: true },
      });
    }
  });
  it('30 hashes are never exposed', async () => {
    const responses = await Promise.all([
      request(app.getHttpServer()).get('/admin-users').set(bearer()),
      request(app.getHttpServer()).get('/auth/me').set(bearer()),
      login(),
    ]);
    const serialized = JSON.stringify(responses.map((item) => item.body));
    expect(serialized).not.toMatch(
      /passwordHash|refreshTokenHash|previousTokenHash/,
    );
  });
  it('refresh cookie has secure browser attributes', async () => {
    const response = await login();
    const header = (response.headers['set-cookie'] as unknown as string[])[0];
    expect(header).toMatch(/HttpOnly/i);
    expect(header).toMatch(/SameSite=Lax/i);
    expect(header).toMatch(/Path=\/auth/i);
    expect(header.includes('Secure')).toBe(
      process.env.AUTH_COOKIE_SECURE === 'true',
    );
  });
});
