import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { NotificationService } from './notification.service';
import { ReportService } from './report.service';
import { PrismaModule } from '../prisma/prisma.module';

@Module({
  imports: [ConfigModule, PrismaModule],
  providers: [NotificationService, ReportService],
  exports: [NotificationService, ReportService],
})
export class NotificationModule {}
