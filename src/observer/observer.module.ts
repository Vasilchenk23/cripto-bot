import { Module } from '@nestjs/common';
import { ObserverService } from './observer.service';
import { WhalesModule } from '../whales/whales.module';

@Module({
  imports: [WhalesModule],
  providers: [ObserverService],
  exports: [ObserverService],
})
export class ObserverModule {}
