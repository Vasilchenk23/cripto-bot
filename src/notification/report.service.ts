import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { PrismaService } from '../prisma/prisma.service';
import { NotificationService } from './notification.service';
import { START_BALANCE } from '../config/constants';

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

    const balance = account?.virtualBalance ?? START_BALANCE;
    const totalPnl = balance - START_BALANCE;
    const pnlSign = totalPnl >= 0 ? '+' : '';
    const pnlPct = ((totalPnl / START_BALANCE) * 100).toFixed(1);

    const buys = recentTrades.filter((t) => t.side === 'BUY');
    const sells = recentTrades.filter((t) => t.side === 'SELL');

    // Calculate period P&L from sells: proceeds vs cost basis
    let periodPnl = 0;
    for (const sell of sells) {
      // Find matching buy to get entry price
      const matchBuy = await this.prisma.trade.findFirst({
        where: { isBot: true, side: 'BUY', tokenMint: sell.tokenMint },
        orderBy: { timestamp: 'desc' },
      });
      if (matchBuy) {
        const proceeds = sell.amountUsd * (sell.priceUsd / matchBuy.priceUsd);
        periodPnl += proceeds - sell.amountUsd;
      }
    }

    const openCount = await this.countOpenPositions();
    const periodSign = periodPnl >= 0 ? '+' : '';

    let msg = `📊 <b>Отчёт за ${label}</b>\n\n`;
    msg += `💰 Баланс: <code>$${balance.toFixed(2)}</code>\n`;
    msg += `📈 P&L всего: <code>${pnlSign}$${totalPnl.toFixed(2)} (${pnlSign}${pnlPct}%)</code>\n`;

    if (sells.length > 0) {
      msg += `\n<b>За ${label}:</b>\n`;
      msg += `  Открыто: ${buys.length}  Закрыто: ${sells.length}\n`;
      msg += `  P&L периода: <code>${periodSign}$${periodPnl.toFixed(2)}</code>\n`;
    } else {
      msg += `\nЗа ${label}: сделок нет\n`;
    }

    msg += `\n⏳ Открытых позиций: <b>${openCount}</b>`;

    await this.notification.send(msg);
    this.logger.log(`[REPORT] ${label} report sent`);
  }

  private async countOpenPositions(): Promise<number> {
    const trades = await this.prisma.trade.findMany({
      where: { isBot: true },
      select: { tokenMint: true, side: true, amountUsd: true },
    });

    const sums = new Map<string, { bought: number; sold: number }>();
    for (const t of trades) {
      const s = sums.get(t.tokenMint) ?? { bought: 0, sold: 0 };
      if (t.side === 'BUY') s.bought += t.amountUsd;
      else s.sold += t.amountUsd;
      sums.set(t.tokenMint, s);
    }

    return [...sums.values()].filter((s) => s.bought - s.sold > 0.01).length;
  }
}
