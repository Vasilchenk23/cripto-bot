import { Module } from '@nestjs/common';
import { TrackingCron } from './tracking.cron';
import { TradingModule } from '../trading/trading.module';
import { WhalesModule } from '../whales/whales.module';

@Module({
  imports: [TradingModule, WhalesModule],
  providers: [TrackingCron],
})
export class TrackingModule {}
