import { Module, forwardRef } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { WhalesService } from './whales.service';
import { WhaleSocketService } from './whale-socket.service';
import { TradingModule } from '../trading/trading.module';
import { PrismaModule } from '../prisma/prisma.module';

@Module({
  imports: [
    ConfigModule,
    PrismaModule,
    forwardRef(() => TradingModule),
  ],
  providers: [WhalesService, WhaleSocketService],
  exports: [WhalesService, WhaleSocketService],
})
export class WhalesModule {}
