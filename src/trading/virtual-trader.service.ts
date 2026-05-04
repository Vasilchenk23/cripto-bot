import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { PrismaService } from '../prisma/prisma.service';
import { WhalesService } from '../whales/whales.service';
import {
  START_BALANCE,
  TRADE_SIZE,
  TP_1,
  TP_FINAL,
  SL,
} from '../config/constants';

interface Position {
  entryPrice: number;
  amountUsd: number; // current value in virtual USD
  symbol: string;
  soldHalf: boolean; // for TP_1 tracking
}

@Injectable()
export class VirtualTraderService implements OnModuleInit {
  private readonly logger = new Logger(VirtualTraderService.name);
  private positions = new Map<string, Position>(); // key: tokenMint

  constructor(
    private readonly prisma: PrismaService,
    private readonly whalesService: WhalesService,
  ) {}

  async onModuleInit() {
    await this.init();
  }

  /** Ensure a single Account row exists and set balance */
  async init() {
    const existing = await this.prisma.account.findUnique({ where: { id: 0 } });
    if (!existing) {
      await this.prisma.account.create({ data: { id: 0, virtualBalance: START_BALANCE } });
    }
    this.logger.log(`[BALANCE] Current: $${(await this.getBalance()).toFixed(2)}`);
  }

  async getBalance(): Promise<number> {
    const acct = await this.prisma.account.findUnique({ where: { id: 0 } });
    return acct?.virtualBalance ?? START_BALANCE;
  }

  /** Called when the tracked whale performs a BUY */
  async onWhaleBuy(tokenMint: string, tokenSymbol: string, priceUsd: number) {
    const balance = await this.getBalance();
    if (balance < TRADE_SIZE) {
      this.logger.warn(`[TRADE] Skipped ${tokenSymbol} buy: Insufficient balance ($${balance.toFixed(2)})`);
      return;
    }

    // Record virtual BUY trade
    await this.prisma.trade.create({
      data: {
        tokenMint,
        tokenSymbol,
        side: 'BUY',
        priceUsd,
        amountUsd: TRADE_SIZE,
        isBot: true,
      },
    });

    // Deduct from balance
    await this.prisma.account.update({
      where: { id: 0 },
      data: { virtualBalance: { decrement: TRADE_SIZE } },
    });

    // Store position
    this.positions.set(tokenMint, { entryPrice: priceUsd, amountUsd: TRADE_SIZE, symbol: tokenSymbol, soldHalf: false });

    this.logger.log(`[TRADE] Bought ${tokenSymbol} at $${priceUsd.toFixed(4)}`);
    this.logger.log(`[BALANCE] Current: $${(await this.getBalance()).toFixed(2)}`);
  }

  /** Called when the tracked whale performs a SELL */
  async onWhaleSell(tokenMint: string, priceUsd: number) {
    const pos = this.positions.get(tokenMint);
    if (!pos) return; // we have no position, nothing to do

    await this.executeSell(tokenMint, priceUsd, true);
  }

  /** Cron job – runs every 30 seconds to evaluate TP/SL */
  @Cron('*/30 * * * * *')
  async processOpenPositions() {
    for (const [mint, pos] of this.positions.entries()) {
      const meta = await this.whalesService.getTokenMetadata(mint);
      if (!meta?.priceUsd) continue;

      const current = meta.priceUsd;
      const entry = pos.entryPrice;

      // Stop loss
      if (current <= entry * SL) {
        await this.executeSell(mint, current, false);
        continue;
      }

      // Take profit first level (sell half)
      if (!pos.soldHalf && current >= entry * TP_1) {
        const halfAmt = pos.amountUsd / 2;
        const profitPct = ((current - entry) / entry) * 100;
        
        await this.prisma.trade.create({
          data: {
            tokenMint: mint,
            tokenSymbol: pos.symbol,
            side: 'SELL',
            priceUsd: current,
            amountUsd: halfAmt,
            isBot: true,
          },
        });

        await this.prisma.account.update({
          where: { id: 0 },
          data: { virtualBalance: { increment: halfAmt } },
        });

        pos.amountUsd -= halfAmt;
        pos.soldHalf = true;
        this.logger.log(`[TRADE] Sold 50% of ${pos.symbol} at $${current.toFixed(4)} (+${profitPct.toFixed(2)}%)`);
        this.logger.log(`[BALANCE] Current: $${(await this.getBalance()).toFixed(2)}`);
        continue;
      }

      // Final take profit (sell remaining)
      if (current >= entry * TP_FINAL) {
        await this.executeSell(mint, current, false);
      }
    }
  }

  /** Helper to sell entire position */
  private async executeSell(tokenMint: string, priceUsd: number, fromWhale: boolean) {
    const pos = this.positions.get(tokenMint);
    if (!pos) return;

    const profitPct = ((priceUsd - pos.entryPrice) / pos.entryPrice) * 100;

    await this.prisma.trade.create({
      data: {
        tokenMint,
        tokenSymbol: pos.symbol,
        side: 'SELL',
        priceUsd,
        amountUsd: pos.amountUsd,
        isBot: true,
      },
    });

    await this.prisma.account.update({
      where: { id: 0 },
      data: { virtualBalance: { increment: pos.amountUsd } },
    });

    this.positions.delete(tokenMint);
    
    const reason = fromWhale ? 'Whale Sold' : 'TP/SL Hit';
    this.logger.log(`[TRADE] Sold ${pos.symbol} (${reason}) at $${priceUsd.toFixed(4)} Result: ${profitPct.toFixed(2)}%`);
    this.logger.log(`[BALANCE] Current: $${(await this.getBalance()).toFixed(2)}`);
  }
}
