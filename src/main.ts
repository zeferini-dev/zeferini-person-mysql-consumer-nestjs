import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { Logger } from '@nestjs/common';
import { AppModule } from './app.module';

async function bootstrap() {
  await NestFactory.createApplicationContext(AppModule, {
    logger: ['log', 'error', 'warn'],
  });
  const logger = new Logger('Bootstrap');
  logger.log('MySQL consumer started');
}

bootstrap().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('Consumer bootstrap failed:', err);
  process.exit(1);
});
