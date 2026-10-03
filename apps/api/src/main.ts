import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app/app.module';
import { configureApp } from './app/configure-app';
import { loadConfig } from './app/config';

async function bootstrap(): Promise<void> {
  // Fails fast with a readable list when required settings are missing (never starts half-configured).
  const config = loadConfig();
  const app = await NestFactory.create(AppModule.forRoot(config), { bufferLogs: false, bodyParser: false });
  configureApp(app, config);
  await app.listen(config.port, '0.0.0.0');
  Logger.log(`API listening on port ${config.port}${config.docs ? ` (docs at /docs)` : ''}`, 'Bootstrap');
}

void bootstrap();
