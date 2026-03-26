import { Module } from '@nestjs/common';
import { AirdropsService } from './airdrops.service';

@Module({
  providers: [AirdropsService],
  exports: [AirdropsService],
})
export class AirdropsModule {}
