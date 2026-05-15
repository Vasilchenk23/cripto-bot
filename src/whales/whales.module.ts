import { Module, forwardRef } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { WhalesService } from './whales.service';
import { WhaleSocketService } from './whale-socket.service';
import { WhaleDiscoveryService } from './whale-discovery.service';
import { TradingModule } from '../trading/trading.module';
import { PrismaModule } from '../prisma/prisma.module';
import { NotificationModule } from '../notification/notification.module';

@Module({
  imports: [
    ConfigModule,
    PrismaModule,
    forwardRef(() => TradingModule),
    NotificationModule,
  ],
  providers: [WhalesService, WhaleSocketService, WhaleDiscoveryService],
  exports: [WhalesService, WhaleSocketService],
})
export class WhalesModule {}
