import { Module } from '@nestjs/common';
import { BotService } from './bot.service';
import { WhalesModule } from '../whales/whales.module';
import { TradingModule } from '../trading/trading.module';

@Module({
  imports: [WhalesModule, TradingModule],
  providers: [BotService],
})
export class BotModule {}
