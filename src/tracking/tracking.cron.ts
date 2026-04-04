import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { ObserverService } from '../observer/observer.service';

@Injectable()
export class TrackingCron {
  private readonly logger = new Logger(TrackingCron.name);

  constructor(private readonly observerService: ObserverService) {}

  @Cron('*/30 * * * * *')
  async updatePeakSnapshots() {
    try {
      await this.observerService.updatePeakProfits();
    } catch (error: any) {
      this.logger.error(`[CRON] Error updating peak snapshots: ${error.message}`);
    }
  }
}
