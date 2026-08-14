import { Logger, ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';
import { allowedOrigins, validateEnvironment } from './config/env';

async function bootstrap() {
  if (!process.env.DATABASE_URL) process.loadEnvFile();
  validateEnvironment();
  const app = await NestFactory.create(AppModule);
  app.use(helmet());
  app.use(cookieParser());
  app.enableCors({
    origin: allowedOrigins(),
    methods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
    credentials: true,
    allowedHeaders: ['Authorization', 'Content-Type'],
  });
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      transform: true,
      forbidNonWhitelisted: true,
    }),
  );
  app.enableShutdownHooks();
  const port = Number(process.env.PORT ?? 3000);
  await app.listen(port);
  new Logger('Bootstrap').log({
    event: 'RUNTIME_STARTED',
    pid: process.pid,
    nodeEnv: process.env.NODE_ENV ?? 'development',
    nodeVersion: process.version,
    port,
    runtimeVersion:
      process.env.RENDER_GIT_COMMIT ?? process.env.GIT_COMMIT ?? null,
  });
}
void bootstrap();
