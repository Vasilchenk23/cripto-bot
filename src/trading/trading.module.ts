import { Module, forwardRef } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { WhalesModule } from '../whales/whales.module';
import { VirtualTraderService } from './virtual-trader.service';

@Module({
  imports: [PrismaModule, forwardRef(() => WhalesModule)],
  providers: [VirtualTraderService],
  exports: [VirtualTraderService],
})
export class TradingModule {}

