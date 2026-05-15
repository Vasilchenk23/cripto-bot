import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { PrismaService } from '../prisma/prisma.service';
import { NotificationService } from './notification.service';
import { START_BALANCE } from '../config/constants';
import axios from 'axios';

interface OpenPosition {
  mint: string;
  symbol: string;
  entryPrice: number;
  investedUsd: number;
}

@Injectable()
export class ReportService {
  private readonly logger = new Logger(ReportService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly notification: NotificationService,
  ) {}

  @Cron('0 0 * * * *') // top of every hour
  async hourlyReport() {
    await this.sendReport(1, '1ч');
  }

  @Cron('0 0 */6 * * *') // every 6 hours
  async sixHourReport() {
    await this.sendReport(6, '6ч');
  }

  @Cron('0 0 0 * * *') // midnight daily
  async dailyReport() {
    await this.sendReport(24, '24ч');
  }

  async sendReport(hours: number, label: string) {
    const since = new Date(Date.now() - hours * 60 * 60 * 1000);

    const [account, recentTrades] = await Promise.all([
      this.prisma.account.findUnique({ where: { id: 0 } }),
      this.prisma.trade.findMany({
        where: { isBot: true, timestamp: { gte: since } },
        orderBy: { timestamp: 'asc' },
      }),
    ]);

    const freeCash = account?.virtualBalance ?? START_BALANCE;

    const buys = recentTrades.filter((t) => t.side === 'BUY');
    const sells = recentTrades.filter((t) => t.side === 'SELL');

    // Period P&L from sells
    let periodPnl = 0;
    for (const sell of sells) {
      const matchBuy = await this.prisma.trade.findFirst({
        where: { isBot: true, side: 'BUY', tokenMint: sell.tokenMint },
        orderBy: { timestamp: 'desc' },
      });
      if (matchBuy) {
        const proceeds = sell.amountUsd * (sell.priceUsd / matchBuy.priceUsd);
        periodPnl += proceeds - sell.amountUsd;
      }
    }

    const { positions } = await this.getOpenPositionsSummary();

    // Fetch current prices and compute real portfolio value
    let currentPositionValue = 0;
    const positionLines: string[] = [];
    for (const pos of positions) {
      const currentPrice = await this.fetchCurrentPrice(pos.mint);
      const currentVal = currentPrice != null
        ? pos.investedUsd * (currentPrice / pos.entryPrice)
        : pos.investedUsd;
      currentPositionValue += currentVal;
      const pnlPct = currentPrice != null
        ? ((currentPrice / pos.entryPrice - 1) * 100).toFixed(1)
        : '?';
      const sign = parseFloat(pnlPct) >= 0 ? '+' : '';
      const emoji = parseFloat(pnlPct) >= 0 ? '🟢' : '🔴';
      positionLines.push(`  ${emoji} ${pos.symbol}: <code>${sign}${pnlPct}%</code>  ($${currentVal.toFixed(2)})`);
    }

    const totalPortfolio = freeCash + currentPositionValue;
    const portfolioPnl = totalPortfolio - START_BALANCE;
    const portfolioPnlSign = portfolioPnl >= 0 ? '+' : '';
    const portfolioPnlPct = ((portfolioPnl / START_BALANCE) * 100).toFixed(1);
    const portfolioEmoji = portfolioPnl >= 0 ? '📈' : '📉';

    let msg = `📊 <b>Отчёт за ${label}</b>\n\n`;

    msg += `🏦 <b>ПОРТФЕЛЬ: <code>$${totalPortfolio.toFixed(2)}</code></b>\n`;
    msg += `${portfolioEmoji} P&L: <code>${portfolioPnlSign}$${portfolioPnl.toFixed(2)} (${portfolioPnlSign}${portfolioPnlPct}%)</code>\n`;
    msg += `\n💵 Свободно: <code>$${freeCash.toFixed(2)}</code>\n`;
    msg += `📦 В позициях: <code>$${currentPositionValue.toFixed(2)}</code> (тек. цена)\n`;

    if (sells.length > 0) {
      const periodSign = periodPnl >= 0 ? '+' : '';
      msg += `\n<b>За ${label}:</b>\n`;
      msg += `  Открыто: ${buys.length}  Закрыто: ${sells.length}\n`;
      msg += `  P&L периода: <code>${periodSign}$${periodPnl.toFixed(2)}</code>\n`;
    } else {
      msg += `\nЗа ${label}: закрытых сделок нет\n`;
    }

    if (positions.length > 0) {
      msg += `\n⏳ <b>Открытых позиций: ${positions.length}</b>\n`;
      msg += positionLines.join('\n');
    } else {
      msg += `\n⏳ Открытых позиций: <b>0</b>`;
    }

    await this.notification.send(msg);
    this.logger.log(`[REPORT] ${label} report sent. Portfolio=$${totalPortfolio.toFixed(2)}`);
  }

  private async fetchCurrentPrice(mint: string): Promise<number | null> {
    try {
      const { data } = await axios.get(
        `https://api.dexscreener.com/latest/dex/tokens/${mint}`,
        { timeout: 5_000 },
      );
      if (data.pairs?.length > 0) {
        const price = parseFloat(data.pairs[0].priceUsd as string);
        if (price > 0) return price;
      }
    } catch {}
    try {
      const { data } = await axios.get(
        `https://api.jup.ag/price/v2?ids=${mint}`,
        { timeout: 5_000 },
      );
      const price = parseFloat(data?.data?.[mint]?.price as string);
      if (price > 0) return price;
    } catch {}
    return null;
  }

  private async getOpenPositionsSummary(): Promise<{ positions: OpenPosition[] }> {
    const trades = await this.prisma.trade.findMany({
      where: { isBot: true },
      select: { tokenMint: true, side: true, amountUsd: true, tokenSymbol: true, priceUsd: true },
      orderBy: { timestamp: 'asc' },
    });

    const sums = new Map<string, { bought: number; sold: number; symbol: string; entryPrice: number }>();
    for (const t of trades) {
      const s = sums.get(t.tokenMint) ?? { bought: 0, sold: 0, symbol: t.tokenSymbol ?? '?', entryPrice: t.priceUsd };
      if (t.side === 'BUY') {
        s.bought += t.amountUsd;
        s.entryPrice = t.priceUsd;
      } else {
        s.sold += t.amountUsd;
      }
      sums.set(t.tokenMint, s);
    }

    const open = [...sums.entries()].filter(([, s]) => s.bought - s.sold > 0.01);
    return {
      positions: open.map(([mint, s]) => ({
        mint,
        symbol: s.symbol,
        entryPrice: s.entryPrice,
        investedUsd: s.bought - s.sold,
      })),
    };
  }
}
