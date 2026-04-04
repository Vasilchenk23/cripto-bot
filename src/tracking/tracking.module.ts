import { Module } from '@nestjs/common';
import { TrackingCron } from './tracking.cron';
import { ObserverModule } from '../observer/observer.module';

@Module({
  imports: [ObserverModule],
  providers: [TrackingCron],
})
export class TrackingModule {}
