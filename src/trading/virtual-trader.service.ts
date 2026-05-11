import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { PrismaService } from '../prisma/prisma.service';
import { WhalesService } from '../whales/whales.service';
import { NotificationService } from '../notification/notification.service';
import {
  START_BALANCE,
  TRADE_SIZE,
  TP_1,
  TP_FINAL,
  SL,
  SLIPPAGE_PENALTY,
  MAX_OPEN_POSITIONS,
} from '../config/constants';

interface Position {
  entryPrice: number;
  amountUsd: number; // remaining original cost basis
  symbol: string;
  soldHalf: boolean;
}

@Injectable()
export class VirtualTraderService implements OnModuleInit {
  private readonly logger = new Logger(VirtualTraderService.name);
  private positions = new Map<string, Position>(); // key: tokenMint

  constructor(
    private readonly prisma: PrismaService,
    private readonly whalesService: WhalesService,
    private readonly notification: NotificationService,
  ) {}

  async onModuleInit() {
    await this.init();
  }

  async init() {
    const existing = await this.prisma.account.findUnique({ where: { id: 0 } });
    if (!existing) {
      await this.prisma.account.create({ data: { id: 0, virtualBalance: START_BALANCE } });
    }
    await this.restorePositions();
    this.logger.log(`[BALANCE] Current: $${(await this.getBalance()).toFixed(2)}`);
  }

  async resetAll() {
    await this.prisma.trade.deleteMany({});
    await this.prisma.account.upsert({
      where: { id: 0 },
      update: { virtualBalance: START_BALANCE },
      create: { id: 0, virtualBalance: START_BALANCE },
    });
    this.positions.clear();
    this.logger.log(`[RESET] All trades deleted, balance reset to $${START_BALANCE}`);
  }

  private async restorePositions() {
    const botTrades = await this.prisma.trade.findMany({
      where: { isBot: true },
      orderBy: { timestamp: 'asc' },
    });

    const mintData = new Map<string, { bought: number; sold: number; lastBuyPrice: number; lastBuySymbol: string; hasSell: boolean }>();

    for (const t of botTrades) {
      const d = mintData.get(t.tokenMint) ?? { bought: 0, sold: 0, lastBuyPrice: 0, lastBuySymbol: 'UNKNOWN', hasSell: false };
      if (t.side === 'BUY') {
        d.bought += t.amountUsd;
        d.lastBuyPrice = t.priceUsd;
        d.lastBuySymbol = t.tokenSymbol ?? 'UNKNOWN';
      } else {
        d.sold += t.amountUsd;
        d.hasSell = true;
      }
      mintData.set(t.tokenMint, d);
    }

    for (const [mint, d] of mintData) {
      const remaining = d.bought - d.sold;
      if (remaining > 0.01) {
        this.positions.set(mint, {
          entryPrice: d.lastBuyPrice,
          amountUsd: remaining,
          symbol: d.lastBuySymbol,
          soldHalf: d.hasSell,
        });
        this.logger.log(`[RESTORE] ${d.lastBuySymbol} remaining=$${remaining.toFixed(2)}`);
      }
    }

    if (this.positions.size > 0) {
      this.logger.log(`[RESTORE] Loaded ${this.positions.size} open positions from DB`);
    }
  }

  async getBalance(): Promise<number> {
    const acct = await this.prisma.account.findUnique({ where: { id: 0 } });
    return acct?.virtualBalance ?? START_BALANCE;
  }

  getOpenPositions(): Map<string, Position> {
    return this.positions;
  }

  // ─── Entry ────────────────────────────────────────────────────────────────

  async onWhaleBuy(tokenMint: string, tokenSymbol: string, whalePrice: number) {
    if (this.positions.has(tokenMint)) {
      this.logger.log(`[TRADE] Skip ${tokenSymbol} — already in position`);
      return;
    }

    if (this.positions.size >= MAX_OPEN_POSITIONS) {
      this.logger.warn(
        `[TRADE] Skip ${tokenSymbol} — max positions (${MAX_OPEN_POSITIONS}) reached`,
      );
      return;
    }

    const balance = await this.getBalance();
    if (balance < TRADE_SIZE) {
      this.logger.warn(
        `[TRADE] Skip ${tokenSymbol} — insufficient balance ($${balance.toFixed(2)})`,
      );
      return;
    }

    const entryPrice = whalePrice * SLIPPAGE_PENALTY;

    await this.prisma.trade.create({
      data: { tokenMint, tokenSymbol, side: 'BUY', priceUsd: entryPrice, amountUsd: TRADE_SIZE, isBot: true },
    });

    await this.prisma.account.update({
      where: { id: 0 },
      data: { virtualBalance: { decrement: TRADE_SIZE } },
    });

    this.positions.set(tokenMint, {
      entryPrice,
      amountUsd: TRADE_SIZE,
      symbol: tokenSymbol,
      soldHalf: false,
    });

    const newBalance = await this.getBalance();
    this.logger.log(
      `[TRADE] OPEN ${tokenSymbol} @$${entryPrice.toFixed(6)} (whale $${whalePrice.toFixed(6)} +7% slip)`,
    );

    void this.notification.send(
      `🤖 <b>BOT OPEN</b>\n` +
        `Token: <b>${tokenSymbol}</b>\n` +
        `Entry: <code>$${entryPrice.toFixed(8)}</code>\n` +
        `<i>Whale price $${whalePrice.toFixed(8)} +7% slippage</i>\n` +
        `Size: <code>$${TRADE_SIZE.toFixed(2)}</code>  Balance: <code>$${newBalance.toFixed(2)}</code>`,
    );
  }

  // ─── Exit triggered by whale ──────────────────────────────────────────────

  async onWhaleSell(tokenMint: string, priceUsd: number, sellPercent = 1.0) {
    if (!this.positions.has(tokenMint)) return;
    await this.executeSell(tokenMint, priceUsd, `Whale Sold ${(sellPercent * 100).toFixed(0)}%`, sellPercent);
  }

  // ─── TP/SL cron — every 5 seconds ────────────────────────────────────────

  @Cron('*/5 * * * * *')
  async processOpenPositions() {
    for (const [mint, pos] of this.positions.entries()) {
      const meta = await this.whalesService.getTokenMetadata(mint);
      if (!meta?.priceUsd) continue;

      const current = meta.priceUsd;
      const entry = pos.entryPrice;

      if (current <= entry * SL) {
        await this.executeSell(mint, current, 'Stop Loss', 1.0);
        continue;
      }

      if (!pos.soldHalf && current >= entry * TP_1) {
        pos.soldHalf = true;
        await this.executeSell(mint, current, 'TP1 +20%', 0.5);
        continue;
      }

      if (current >= entry * TP_FINAL) {
        await this.executeSell(mint, current, 'TP2 +50%', 1.0);
      }
    }
  }

  // ─── Core sell logic ──────────────────────────────────────────────────────

  private async executeSell(
    tokenMint: string,
    priceUsd: number,
    reason: string,
    sellRatio: number,
  ) {
    const pos = this.positions.get(tokenMint);
    if (!pos) return;

    const ratio = Math.min(Math.max(sellRatio, 0), 1);
    const costBasisSold = pos.amountUsd * ratio;
    // Actual money received at current price
    const saleProceeds = costBasisSold * (priceUsd / pos.entryPrice);
    const profitPct = (priceUsd / pos.entryPrice - 1) * 100;
    const pnlUsd = saleProceeds - costBasisSold;

    await this.prisma.trade.create({
      data: {
        tokenMint,
        tokenSymbol: pos.symbol,
        side: 'SELL',
        priceUsd,
        amountUsd: costBasisSold,
        isBot: true,
      },
    });

    // Credit actual sale proceeds, not the original cost basis
    await this.prisma.account.update({
      where: { id: 0 },
      data: { virtualBalance: { increment: saleProceeds } },
    });

    if (ratio >= 1.0) {
      this.positions.delete(tokenMint);
    } else {
      pos.amountUsd -= costBasisSold;
    }

    const balance = await this.getBalance();
    const sign = profitPct >= 0 ? '+' : '';
    this.logger.log(
      `[TRADE] CLOSE ${(ratio * 100).toFixed(0)}% ${pos.symbol} (${reason}) @$${priceUsd.toFixed(6)} ${sign}${profitPct.toFixed(2)}%`,
    );

    const emoji = pnlUsd >= 0 ? '✅' : '❌';
    const pnlSign = pnlUsd >= 0 ? '+' : '';
    void this.notification.send(
      `${emoji} <b>BOT CLOSE ${(ratio * 100).toFixed(0)}%</b> — ${reason}\n` +
        `Token: <b>${pos.symbol}</b>\n` +
        `Exit: <code>$${priceUsd.toFixed(8)}</code>\n` +
        `P&L: <code>${sign}${profitPct.toFixed(2)}%</code>  <code>${pnlSign}$${pnlUsd.toFixed(2)}</code>\n` +
        `Balance: <code>$${balance.toFixed(2)}</code>`,
    );
  }
}
