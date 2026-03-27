import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { TradingService } from '../trading/trading.service';
import { WhalesService } from '../whales/whales.service';
import { BotService } from '../bot/bot.service';
import { Bot } from 'grammy';
import { ConfigService } from '@nestjs/config';

@Injectable()
export class TrackingCron {
  private readonly logger = new Logger(TrackingCron.name);
  private readonly bot: Bot;
  private readonly myTelegramId: string;

  constructor(
    private readonly tradingService: TradingService,
    private readonly whalesService: WhalesService,
    private readonly configService: ConfigService,
  ) {
    const token = this.configService.getOrThrow<string>('TELEGRAM_BOT_TOKEN');
    this.myTelegramId = this.configService.getOrThrow<string>('MY_TELEGRAM_ID');
    this.bot = new Bot(token);
  }

  @Cron(CronExpression.EVERY_MINUTE)
  async checkPnLReports() {
    const openTrades = await this.tradingService.getOpenTrades();
    if (openTrades.length === 0) return;

    const now = Date.now();

    for (const trade of openTrades) {
      const elapsedMs = now - trade.timestamp.getTime();
      const elapsedMin = elapsedMs / (60 * 1000);

      const intervals = [
        { key: 'report15m', min: 15, label: '15m' },
        { key: 'report1h', min: 60, label: '1h' },
        { key: 'report4h', min: 240, label: '4h' },
        { key: 'report12h', min: 720, label: '12h' },
        { key: 'report24h', min: 1440, label: '24h' },
      ];

      for (const interval of intervals) {
        if (
          elapsedMin >= interval.min &&
          !trade[interval.key as keyof typeof trade]
        ) {
          await this.sendPnLReport(trade, interval.label, interval.key);
          break;
        }
      }
    }
  }

  private async sendPnLReport(trade: any, label: string, key: string) {
    try {
      // Fetch current price
      const metadata = await (this.whalesService as any).getTokenMetadata(
        trade.tokenMint,
      );
      if (!metadata) return;

      const currentPrice = metadata.priceUsd;
      const pnlPercent =
        ((currentPrice - trade.entryPrice) / trade.entryPrice) * 100;
      const pnlUAH = (trade.amountUAH * pnlPercent) / 100;
      const emoji = pnlPercent >= 0 ? '📈' : '📉';

      const text = [
        `📊 <b>VIRTUAL PnL REPORT (${label})</b>`,
        '',
        `💎 <b>Token:</b> ${trade.symbol || ''} <code>${trade.tokenMint}</code>`,
        `💰 <b>Entry:</b> ${trade.entryPrice.toFixed(8)}`,
        `💵 <b>Current:</b> ${currentPrice.toFixed(8)}`,
        '━━━━━━━━━━━━━━━',
        `${emoji} <b>Profit:</b> ${pnlPercent.toFixed(2)}%`,
        `💵 <b>PnL (UAH):</b> ${pnlUAH.toFixed(2)} UAH`,
        '━━━━━━━━━━━━━━━',
      ].join('\n');

      await this.bot.api.sendMessage(this.myTelegramId, text, {
        parse_mode: 'HTML',
      });

      // Update trade to mark report as sent
      await (this.tradingService as any).prisma.virtualTrade.update({
        where: { id: trade.id },
        data: { [key]: true },
      });

      this.logger.log(`Sent ${label} PnL report for ${trade.tokenMint}`);
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(`Error sending PnL report: ${message}`);
    }
  }
}
