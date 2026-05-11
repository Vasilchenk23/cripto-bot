import { Module } from '@nestjs/common';
import { BotService } from './bot.service';
import { WhalesModule } from '../whales/whales.module';
import { TradingModule } from '../trading/trading.module';
import { PrismaModule } from '../prisma/prisma.module';
import { NotificationModule } from '../notification/notification.module';

@Module({
  imports: [WhalesModule, TradingModule, PrismaModule, NotificationModule],
  providers: [BotService],
})
export class BotModule {}
