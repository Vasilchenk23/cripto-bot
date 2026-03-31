import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { WhalesService } from './whales.service';
import { WhaleSocketService } from './whale-socket.service';

@Module({
  imports: [ConfigModule],
  providers: [WhalesService, WhaleSocketService],
  exports: [WhalesService, WhaleSocketService],
})
export class WhalesModule {}
