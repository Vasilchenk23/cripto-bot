import { Global, Module } from '@nestjs/common';
import { PrismaService } from './prisma.service';

/**
 * Global module that provides the PrismaService to the entire application.
 */
@Global()
@Module({
  providers: [PrismaService],
  exports: [PrismaService],
})
export class PrismaModule {}
