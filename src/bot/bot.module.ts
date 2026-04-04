import { Module } from '@nestjs/common';
import { BotService } from './bot.service';
import { WhalesModule } from '../whales/whales.module';
import { ObserverModule } from '../observer/observer.module';

@Module({
  imports: [WhalesModule, ObserverModule],
  providers: [BotService],
})
export class BotModule {}
