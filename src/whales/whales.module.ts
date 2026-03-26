import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { WhalesService } from './whales.service';

@Module({
  imports: [ConfigModule],
  providers: [WhalesService],
  exports: [WhalesService],
})
export class WhalesModule {}
