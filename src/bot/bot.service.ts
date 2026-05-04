import { Injectable, Logger, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Bot } from 'grammy';
import { VirtualTraderService } from '../trading/virtual-trader.service';
import { WhalesService } from '../whales/whales.service';

@Injectable()
export class BotService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(BotService.name);
  private readonly bot: Bot;
  private readonly ADMIN_ID: string;

  constructor(
    private readonly configService: ConfigService,
    private readonly whalesService: WhalesService,
    private readonly virtualTrader: VirtualTraderService,
  ) {
    const token = this.configService.getOrThrow<string>('TELEGRAM_BOT_TOKEN');
    this.ADMIN_ID = this.configService.getOrThrow<string>('MY_TELEGRAM_ID');
    this.bot = new Bot(token);
  }

  async onModuleInit() {
    this.bot.catch((err) => this.logger.error(`Bot error: ${err.message}`));
    this.registerCommands();
    this.bot.start();
    this.logger.log('🐋 Shadow Trader bot started');
  }

  onModuleDestroy() {}

  private registerCommands() {
    this.bot.command('start', async (ctx) => {
      await ctx.reply('🐋 Shadow Trader is online.');
    });

    this.bot.command('status', async (ctx) => {
      const balance = await this.virtualTrader.getBalance();
      await ctx.reply(`[BALANCE] Current: $${balance.toFixed(2)}`);
    });
  }
}
