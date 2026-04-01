import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';

if (!global.crypto) {
  try {
    global.crypto = require('crypto').webcrypto;
  } catch (e) {
    console.error('Failed to patch crypto:', e);
  }
}

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  await app.listen(process.env.PORT ?? 3000);
}
bootstrap();
