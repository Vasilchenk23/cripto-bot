import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ScheduleModule } from '@nestjs/schedule';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { BotModule } from './bot/bot.module';
import { MarketModule } from './market/market.module';
import { NewsModule } from './news/news.module';
import { TrackingModule } from './tracking/tracking.module';
import { ObserverModule } from './observer/observer.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    ScheduleModule.forRoot(),
    BotModule,
    MarketModule,
    NewsModule,
    TrackingModule,
    ObserverModule,
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
