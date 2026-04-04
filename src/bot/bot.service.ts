import {
  Injectable,
  Logger,
  OnModuleInit,
  OnModuleDestroy,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Bot, InlineKeyboard, InputFile } from 'grammy';
import { WhalesService } from '../whales/whales.service';
import { WhaleAlert } from '../whales/whales.interfaces';
import { ObserverService } from '../observer/observer.service';

@Injectable()
export class BotService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(BotService.name);
  private readonly bot: Bot;
  private readonly CHAT_ID: string;

  constructor(
    private readonly configService: ConfigService,
    private readonly whalesService: WhalesService,
    private readonly observerService: ObserverService,
  ) {
    const token = this.configService.getOrThrow<string>('TELEGRAM_BOT_TOKEN');
    this.CHAT_ID = this.configService.getOrThrow<string>('MY_TELEGRAM_ID');
    this.bot = new Bot(token);
  }

  async onModuleInit() {
    this.bot.catch((err) => this.logger.error(`Bot error: ${err.message}`));
    this.registerCommands();
    this.registerWhaleCallbacks();

    this.whalesService.alert$.subscribe((alert) => {
      this.handleWhaleAlert(alert);
    });

    this.bot.start();
    this.logger.log('🐋 Observer Mode bot started');
  }

  onModuleDestroy() {}

  private registerCommands() {
    this.bot.command('start', async (ctx) => {
      await ctx.reply(
        '🐋 <b>Observer Mode</b> is active.\n\nTracking whale entries. Use /manage to view whales, /get_dump to export data.',
        { parse_mode: 'HTML' },
      );
    });

    this.bot.command('addwhale', async (ctx) => {
      if (!ctx.message?.text) return;
      const parts = ctx.message.text.split(' ');
      const address = parts[1];
      const name = parts.slice(2).join(' ');

      if (!address || !this.whalesService.isValidSolanaAddress(address)) {
        return ctx.reply(
          '❌ Invalid Solana address. Must be 32-44 base58 characters.',
        );
      }

      try {
        await this.whalesService.addWhale(address, name || 'Unknown Whale');
        await ctx.reply(
          [
            '✅ <b>Whale added!</b>',
            `👤 <b>Name:</b> ${name || 'Unknown'}`,
            `📍 <b>Address:</b> <code>${address}</code>`,
          ].join('\n'),
          { parse_mode: 'HTML' },
        );
      } catch {
        await ctx.reply('❌ Whale already exists or DB error.');
      }
    });

    this.bot.command('manage', async (ctx) => {
      await this.sendWhaleList(ctx);
    });

    this.bot.command('get_dump', async (ctx) => {
      await this.handleGetDump(ctx);
    });
  }

  private registerWhaleCallbacks() {
    this.bot.callbackQuery(/whale_detail_(\d+)/, async (ctx) => {
      await ctx.answerCallbackQuery().catch(() => {});
      const whaleId = parseInt(ctx.match[1], 10);
      const detail = await this.whalesService.getWhaleDetail(whaleId);

      if (!detail) {
        return ctx.reply('❌ Whale not found.');
      }

      const mints =
        detail.recentMints.length > 0
          ? detail.recentMints
              .map((m, i) => `   ${i + 1}. <code>${m.slice(0, 16)}...</code>`)
              .join('\n')
          : '   No trades yet';

      const text = [
        `🐋 <b>${detail.name}</b>`,
        '━━━━━━━━━━━━━━━',
        `📍 <code>${detail.address}</code>`,
        `📊 Total Trades: <b>${detail.totalTrades}</b>`,
        `⚡ Status: ${detail.isActive ? '🟢 Active' : '🔴 Inactive'}`,
        '',
        '💎 <b>Recent Tokens:</b>',
        mints,
      ].join('\n');

      const keyboard = new InlineKeyboard()
        .url('🔍 Solscan', `https://solscan.io/account/${detail.address}`)
        .row()
        .text('🗑 Delete Whale', `whale_delete_${detail.id}`)
        .text('◀️ Back', 'whale_list');

      await ctx.reply(text, {
        parse_mode: 'HTML',
        reply_markup: keyboard,
        link_preview_options: { is_disabled: true },
      });
    });

    this.bot.callbackQuery(/whale_delete_(\d+)/, async (ctx) => {
      await ctx.answerCallbackQuery().catch(() => {});
      const whaleId = parseInt(ctx.match[1], 10);
      const deleted = await this.whalesService.deleteWhale(whaleId);

      if (deleted) {
        await ctx.editMessageText('✅ Whale deleted successfully.');
      } else {
        await ctx.editMessageText('❌ Whale not found or already deleted.');
      }
    });

    this.bot.callbackQuery('whale_list', async (ctx) => {
      await ctx.answerCallbackQuery().catch(() => {});
      await this.sendWhaleList(ctx);
    });
  }

  private async handleWhaleAlert(alert: WhaleAlert) {
    try {
      const whales = await this.whalesService.getActiveWhales();
      const whale = whales.find((w) => w.address === alert.whaleAddress);
      if (!whale) return;

      await this.observerService.recordTrade({
        whaleId: whale.id,
        tokenSymbol: alert.tokenSymbol,
        mintAddress: alert.tokenMint,
        action: alert.type,
        usdAmount: alert.amountUSD || 0,
        entryPrice: alert.amountUSD && alert.amount ? alert.amountUSD / alert.amount : 0,
        signalReceivedAt: alert.signalReceivedAt,
      });

      if (alert.type === 'BUY') {
        const symbol = alert.tokenSymbol || alert.tokenMint.slice(0, 8);
        const amount = alert.amountUSD?.toFixed(0) || '?';
        const text = `🐋 ENTRY: ${alert.whaleName} -> ${symbol} на $${amount}`;

        await this.bot.api.sendMessage(this.CHAT_ID, text).catch((err) => {
          this.logger.error(`[TG] Failed to send entry alert: ${err.message}`);
        });
      }
    } catch (error: any) {
      this.logger.error(`[ALERT] Error handling alert: ${error.message}`);
    }
  }

  private async handleGetDump(ctx: any) {
    if (ctx.from?.id?.toString() !== this.CHAT_ID) {
      return ctx.reply('❌ Access denied.');
    }

    try {
      const trades = await this.observerService.getAllTrades();
      const dump = JSON.stringify(trades, null, 2);
      const buffer = Buffer.from(dump, 'utf-8');

      await ctx.replyWithDocument(
        new InputFile(buffer, 'whale_analysis.json'),
        { caption: `📊 Database dump: ${trades.length} records` },
      );
    } catch (error: any) {
      this.logger.error(`[DUMP] Error generating dump: ${error.message}`);
      await ctx.reply('❌ Error generating dump.');
    }
  }

  private async sendWhaleList(ctx: { reply: Function }) {
    const whales = await this.whalesService.getActiveWhales();

    if (whales.length === 0) {
      return ctx.reply(
        '🐋 No whales tracked yet.\nUse /addwhale <address> <name> to add one.',
      );
    }

    const keyboard = new InlineKeyboard();
    for (const whale of whales) {
      keyboard.text(
        `🐋 ${whale.name} (${whale.address.slice(0, 6)}...)`,
        `whale_detail_${whale.id}`,
      );
      keyboard.row();
    }

    await ctx.reply('🐋 <b>Tracked Whales:</b>\nTap to view details.', {
      parse_mode: 'HTML',
      reply_markup: keyboard,
    });
  }
}
