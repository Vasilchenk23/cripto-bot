import { Module } from '@nestjs/common';
import { BotService } from './bot.service';
import { MarketModule } from '../market/market.module';
import { NewsModule } from '../news/news.module';
import { AirdropsModule } from 'src/airdrops/airdrops.module';
import { NotesModule } from 'src/notes/notes.module';
import { WhalesModule } from 'src/whales/whales.module';
import { TradingModule } from '../trading/trading.module';

@Module({
  imports: [
    MarketModule,
    NewsModule,
    AirdropsModule,
    NotesModule,
    WhalesModule,
    TradingModule,
  ],
  providers: [BotService],
})
export class BotModule {}
