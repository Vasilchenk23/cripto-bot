import { Injectable, Logger, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Bot } from 'grammy';
import { VirtualTraderService } from '../trading/virtual-trader.service';
import { WhaleSocketService } from '../whales/whale-socket.service';
import { PrismaService } from '../prisma/prisma.service';
import { ReportService } from '../notification/report.service';

@Injectable()
export class BotService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(BotService.name);
  private readonly bot: Bot;
  private readonly adminId: string;

  constructor(
    private readonly configService: ConfigService,
    private readonly virtualTrader: VirtualTraderService,
    private readonly whaleSocket: WhaleSocketService,
    private readonly prisma: PrismaService,
    private readonly reportService: ReportService,
  ) {
    const token = this.configService.getOrThrow<string>('TELEGRAM_BOT_TOKEN');
    this.adminId = this.configService.getOrThrow<string>('MY_TELEGRAM_ID');
    this.bot = new Bot(token);
  }

  async onModuleInit() {
    this.bot.catch((err) => this.logger.error(`Bot error: ${err.message}`));
    this.registerCommands();
    this.bot.start();
    this.logger.log('🐋 Shadow Trader bot started');
  }

  onModuleDestroy() {
    void this.bot.stop();
  }

  private registerCommands() {
    this.bot.command('start', async (ctx) => {
      await ctx.reply(
        '🐋 <b>Shadow Trader</b> — онлайн.\n\n' +
          '/status — баланс и открытые позиции\n' +
          '/trades — последние 10 сделок\n' +
          '/whales — отслеживаемые киты\n' +
          '/report — отчёт прямо сейчас\n' +
          '/reset — сбросить баланс и сделки',
        { parse_mode: 'HTML' },
      );
    });

    this.bot.command('status', async (ctx) => {
      const balance = await this.virtualTrader.getBalance();
      const positions = this.virtualTrader.getOpenPositions();

      let text = `💰 <b>Баланс:</b> <code>$${balance.toFixed(2)}</code>\n`;
      text += `📊 <b>Позиций:</b> ${positions.size}\n\n`;

      if (positions.size === 0) {
        text += '📭 Открытых позиций нет';
      } else {
        for (const [mint, pos] of positions) {
          text +=
            `• <b>${pos.symbol}</b>  entry <code>$${pos.entryPrice.toFixed(8)}</code>\n` +
            `  basis <code>$${pos.amountUsd.toFixed(2)}</code>  TP1 ${pos.soldHalf ? '✓' : '✗'}\n` +
            `  <code>${mint.slice(0, 8)}...</code>\n`;
        }
      }

      await ctx.reply(text, { parse_mode: 'HTML' });
    });

    this.bot.command('trades', async (ctx) => {
      const trades = await this.prisma.trade.findMany({
        orderBy: { timestamp: 'desc' },
        take: 10,
      });

      if (trades.length === 0) {
        await ctx.reply('Сделок пока нет.');
        return;
      }

      const lines = trades.map((t) => {
        const date = t.timestamp.toISOString().slice(5, 16).replace('T', ' ');
        const who = t.isBot ? '🤖' : '🐋';
        const side = t.side === 'BUY' ? '🟢' : '🔴';
        return (
          `${who}${side} <b>${t.tokenSymbol ?? '?'}</b> ` +
          `<code>$${t.priceUsd.toFixed(6)}</code>  $${t.amountUsd.toFixed(2)}  <i>${date}</i>`
        );
      });

      await ctx.reply(
        `📋 <b>Последние ${trades.length} сделок:</b>\n\n` + lines.join('\n'),
        { parse_mode: 'HTML' },
      );
    });

    this.bot.command('whales', async (ctx) => {
      const tracked = this.whaleSocket.getTrackedCount();
      await ctx.reply(
        `🐋 <b>Отслеживается китов:</b> ${tracked}\n\n` +
          `Обновляется каждые 15 минут.\n` +
          `Источники: Birdeye, Cielo + ручной кит.`,
        { parse_mode: 'HTML' },
      );
    });

    this.bot.command('report', async (ctx) => {
      await ctx.reply('⏳ Генерирую отчёт...');
      await this.reportService.sendReport(24, '24ч');
    });

    this.bot.command('reset', async (ctx) => {
      if (ctx.from?.id?.toString() !== this.adminId) {
        await ctx.reply('⛔ Нет доступа.');
        return;
      }
      await this.virtualTrader.resetAll();
      await ctx.reply(
        '✅ <b>Сброс выполнен</b>\n' +
          'Все сделки удалены, баланс = <code>$200.00</code>',
        { parse_mode: 'HTML' },
      );
    });
  }
}
