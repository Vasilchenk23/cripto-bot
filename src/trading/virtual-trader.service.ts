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
import axios from 'axios';

// Max time to hold a position before force-closing (safety net when price feeds fail)
const MAX_HOLD_MS = 72 * 60 * 60 * 1000; // 72 hours

interface Position {
  entryPrice: number;
  amountUsd: number;
  symbol: string;
  soldHalf: boolean;
  openedAt: number; // unix ms
}

@Injectable()
export class VirtualTraderService implements OnModuleInit {
  private readonly logger = new Logger(VirtualTraderService.name);
  private positions = new Map<string, Position>();
  private slCronRunning = false; // prevents concurrent cron runs

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

    const mintData = new Map<string, {
      bought: number; sold: number;
      lastBuyPrice: number; lastBuySymbol: string;
      hasSell: boolean; firstBuyAt: number;
    }>();

    for (const t of botTrades) {
      const d = mintData.get(t.tokenMint) ?? {
        bought: 0, sold: 0,
        lastBuyPrice: 0, lastBuySymbol: 'UNKNOWN',
        hasSell: false, firstBuyAt: t.timestamp.getTime(),
      };
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
          openedAt: d.firstBuyAt,
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
      this.logger.warn(`[TRADE] Skip ${tokenSymbol} — max positions (${MAX_OPEN_POSITIONS}) reached`);
      return;
    }

    const balance = await this.getBalance();
    if (balance < TRADE_SIZE) {
      this.logger.warn(`[TRADE] Skip ${tokenSymbol} — insufficient balance ($${balance.toFixed(2)})`);
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
      openedAt: Date.now(),
    });

    const newBalance = await this.getBalance();
    const positionsList = [...this.positions.values()].map((p) => p.symbol).join(', ');

    this.logger.log(`[TRADE] OPEN ${tokenSymbol} @$${entryPrice.toFixed(6)}`);
    void this.notification.send(
      `🟢 <b>ОТКРЫТА ПОЗИЦИЯ</b>\n` +
        `Токен: <b>${tokenSymbol}</b>\n` +
        `Вход: <code>$${entryPrice.toFixed(8)}</code>\n` +
        `Размер: <code>$${TRADE_SIZE.toFixed(2)}</code>\n` +
        `\n💰 Баланс: <code>$${newBalance.toFixed(2)}</code>\n` +
        `📊 Открыто позиций: <b>${this.positions.size}/${MAX_OPEN_POSITIONS}</b>  [${positionsList}]`,
    );
  }

  // ─── Exit triggered by whale ──────────────────────────────────────────────

  async onWhaleSell(tokenMint: string, priceUsd: number, sellPercent = 1.0) {
    if (!this.positions.has(tokenMint)) return;

    // Ignore dust sells: whale sold < 5% of their position — not a real exit signal
    if (sellPercent < 0.05) {
      const pos = this.positions.get(tokenMint)!;
      this.logger.debug(`[TRADE] Skip ${pos.symbol} sell — whale sold only ${(sellPercent * 100).toFixed(2)}% (dust)`);
      return;
    }

    const pos = this.positions.get(tokenMint)!;
    // Price sanity check: reject if price is 5x+ above entry — likely wrong price source
    if (priceUsd > pos.entryPrice * 5) {
      this.logger.warn(`[TRADE] Skip ${pos.symbol} sell — price anomaly ($${priceUsd.toFixed(6)} vs entry $${pos.entryPrice.toFixed(6)})`);
      return;
    }

    await this.executeSell(tokenMint, priceUsd, `Whale Sold ${(sellPercent * 100).toFixed(0)}%`, sellPercent);
  }

  // ─── TP/SL cron — every 30 seconds ───────────────────────────────────────

  @Cron('*/30 * * * * *')
  async processOpenPositions() {
    // Guard: skip if previous run hasn't finished (prevents concurrent HTTP calls → rate limit)
    if (this.slCronRunning || this.positions.size === 0) return;
    this.slCronRunning = true;

    try {
      const entries = [...this.positions.entries()];
      const mints = entries.map(([mint]) => mint);

      // Fetch all prices in one batched request instead of N sequential calls
      const prices = await this.fetchPricesBatch(mints);

      for (const [mint, pos] of entries) {
        // Safety net: force-close positions stuck open too long (price feed dead)
        const heldMs = Date.now() - pos.openedAt;
        if (heldMs > MAX_HOLD_MS) {
          this.logger.warn(`[TP/SL] ${pos.symbol}: удерживается ${Math.round(heldMs / 3600000)}ч — принудительное закрытие`);
          await this.executeSell(mint, prices.get(mint) ?? pos.entryPrice * SL, 'Force Close (72h)', 1.0);
          continue;
        }

        const price = prices.get(mint) ?? null;
        if (price === null) {
          this.logger.warn(`[TP/SL] ${pos.symbol}: цена недоступна (Jupiter + DexScreener)`);
          continue;
        }

        const changePct = ((price / pos.entryPrice - 1) * 100).toFixed(1);
        const sign = parseFloat(changePct) >= 0 ? '+' : '';
        this.logger.debug(`[TP/SL] ${pos.symbol}: ${sign}${changePct}%  (entry=$${pos.entryPrice.toFixed(6)} now=$${price.toFixed(6)})`);

        if (price <= pos.entryPrice * SL) {
          await this.executeSell(mint, price, `Stop Loss ${((price / pos.entryPrice - 1) * 100).toFixed(1)}%`, 1.0);
          continue;
        }

        if (!pos.soldHalf && price >= pos.entryPrice * TP_1) {
          pos.soldHalf = true;
          await this.executeSell(mint, price, 'TP1 +20%', 0.5);
          continue;
        }

        if (pos.soldHalf && price >= pos.entryPrice * TP_FINAL) {
          await this.executeSell(mint, price, 'TP2 +50%', 1.0);
        }
      }
    } finally {
      this.slCronRunning = false;
    }
  }

  // Batch price fetch: one Jupiter request for all mints, DexScreener per-mint only as fallback
  private async fetchPricesBatch(mints: string[]): Promise<Map<string, number>> {
    const result = new Map<string, number>();
    if (mints.length === 0) return result;

    // Jupiter: single request for all mints
    try {
      const { data } = await axios.get(
        `https://api.jup.ag/price/v2?ids=${mints.join(',')}`,
        { timeout: 5_000 },
      );
      for (const mint of mints) {
        const price = parseFloat(data?.data?.[mint]?.price as string);
        if (price > 0) result.set(mint, price);
      }
    } catch {
      // fall through to DexScreener
    }

    // DexScreener only for mints Jupiter didn't return
    const missing = mints.filter((m) => !result.has(m));
    await Promise.all(
      missing.map(async (mint) => {
        try {
          const { data } = await axios.get(
            `https://api.dexscreener.com/latest/dex/tokens/${mint}`,
            { timeout: 5_000 },
          );
          if (data.pairs?.length > 0) {
            const price = parseFloat(data.pairs[0].priceUsd as string);
            if (price > 0) result.set(mint, price);
          }
        } catch {
          // price stays missing
        }
      }),
    );

    return result;
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
    this.logger.log(`[TRADE] CLOSE ${(ratio * 100).toFixed(0)}% ${pos.symbol} (${reason}) @$${priceUsd.toFixed(6)} ${sign}${profitPct.toFixed(2)}%`);

    const emoji = pnlUsd >= 0 ? '🟢' : '🔴';
    const pnlSign = pnlUsd >= 0 ? '+' : '';
    const remainingList = [...this.positions.values()].map((p) => p.symbol).join(', ');
    const remainingStr = this.positions.size > 0 ? `[${remainingList}]` : 'нет';

    void this.notification.send(
      `${emoji} <b>ЗАКРЫТА ${(ratio * 100).toFixed(0)}%</b> — ${reason}\n` +
        `Токен: <b>${pos.symbol}</b>\n` +
        `Выход: <code>$${priceUsd.toFixed(8)}</code>\n` +
        `P&L: <code>${sign}${profitPct.toFixed(2)}%</code>  (<code>${pnlSign}$${pnlUsd.toFixed(2)}</code>)\n` +
        `\n💰 Баланс: <code>$${balance.toFixed(2)}</code>\n` +
        `📊 Осталось позиций: <b>${this.positions.size}/${MAX_OPEN_POSITIONS}</b>  ${remainingStr}`,
    );
  }
}
