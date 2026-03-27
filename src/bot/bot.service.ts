import {
  Injectable,
  Logger,
  OnModuleInit,
  OnModuleDestroy,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Bot, Keyboard, InlineKeyboard } from 'grammy';
import { MarketService } from '../market/market.service';
import { NewsService } from '../news/news.service';
import { AirdropsService } from '../airdrops/airdrops.service';
import { NotesService } from '../notes/notes.service';
import { WhalesService } from '../whales/whales.service';
import { WhaleAlert } from '../whales/whales.interfaces';
import { TradingService } from '../trading/trading.service';

@Injectable()
export class BotService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(BotService.name);
  private readonly bot: Bot;
  private readonly myTelegramId: string;
  private monitorInterval: ReturnType<typeof setInterval> | null = null;
  private isTracking = false;

  private static readonly TRACK_INTERVAL_MS = 60_000;

  constructor(
    private readonly configService: ConfigService,
    private readonly marketService: MarketService,
    private readonly newsService: NewsService,
    private readonly airdropsService: AirdropsService,
    private readonly notesService: NotesService,
    private readonly whalesService: WhalesService,
    private readonly tradingService: TradingService,
  ) {
    const token = this.configService.getOrThrow<string>('TELEGRAM_BOT_TOKEN');
    this.myTelegramId = this.configService.getOrThrow<string>('MY_TELEGRAM_ID');
    this.bot = new Bot(token);
  }

  async onModuleInit() {
    this.bot.catch((err) => this.logger.error(`Bot error: ${err.message}`));
    this.registerCommands();
    this.registerMenuHandlers();
    this.registerWhaleCallbacks();
    this.registerTradingCallbacks();
    this.startWhaleMonitoring();
    this.bot.start();
    this.logger.log('Bot started successfully');
  }

  onModuleDestroy() {
    if (this.monitorInterval) {
      clearInterval(this.monitorInterval);
      this.monitorInterval = null;
      this.logger.log('Whale monitoring stopped');
    }
  }

  private registerCommands() {
    const mainMenu = new Keyboard()
      .text('📊 Market')
      .text('📰 News')
      .row()
      .text('🪂 Airdrops')
      .text('🛡 Laboratory')
      .row()
      .text('🐋 Manage Whales')
      .resized();

    this.bot.command('start', async (ctx) => {
      await ctx.reply('Sup, Max! Crypto HQ is online.', {
        reply_markup: mainMenu,
      });
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

    this.bot.command('portfolio', async (ctx) => {
      await this.sendPortfolio(ctx);
    });
  }

  private registerMenuHandlers() {
    this.bot.hears('📊 Market', async (ctx) => {
      const prices = await this.marketService.getTopPrices();
      await ctx.reply(prices, { parse_mode: 'Markdown' });
    });

    this.bot.hears('📰 News', async (ctx) => {
      const newsMenu = new InlineKeyboard()
        .text('🌍 Global Hot', 'news_global')
        .text('🇺🇦 Local News', 'news_local')
        .row()
        .text('💎 Personal Picks', 'news_personal');
      await ctx.reply('⚡️ *Select News Source:*', {
        reply_markup: newsMenu,
        parse_mode: 'Markdown',
      });
    });

    this.bot.hears('🪂 Airdrops', async (ctx) => {
      const drops = await this.airdropsService.getActiveAirdrops();
      if (!drops.length) {
        return ctx.reply('🪂 *Airdrop list is empty.*', {
          parse_mode: 'Markdown',
        });
      }
      let text = '🚀 *Active Airdrops:* \n\n';
      for (const drop of drops) {
        text += `🔹 *${drop.name}* [${drop.status}]\n${drop.link ? `🔗 [Participate](${drop.link})\n\n` : '\n'}`;
      }
      await ctx.reply(text, {
        parse_mode: 'Markdown',
        link_preview_options: { is_disabled: true },
      });
    });

    this.bot.callbackQuery(/news_(.+)/, async (ctx) => {
      await ctx.answerCallbackQuery().catch(() => {});
      const type = ctx.match[1];
      let news: Array<{ title: string; url: string }> | null | undefined;

      if (type === 'global') news = await this.newsService.getGlobalHot();
      else if (type === 'local') news = await this.newsService.getLocalNews();

      if (!news || news.length === 0)
        return ctx.reply('❌ Error fetching news.');

      const text = news.map((n) => `🔥 [${n.title}](${n.url})`).join('\n\n');
      await ctx.reply(`*News Feed:*\n\n${text}`, {
        parse_mode: 'Markdown',
        link_preview_options: { is_disabled: true },
      });
    });

    this.bot.hears('🐋 Manage Whales', async (ctx) => {
      await this.sendWhaleList(ctx);
    });

    this.bot.hears('🛡 Laboratory', async (ctx) => {
      try {
        const stats = await this.whalesService.getGlobalStats();
        const mostActive = stats.mostActiveWhale
          ? `${stats.mostActiveWhale.name} (${stats.mostActiveWhale.tradeCount} trades)`
          : 'No data yet';

        const sniper = stats.sniperOfTheDay
          ? `${stats.sniperOfTheDay.name}\n   └ <code>${stats.sniperOfTheDay.tokenMint.slice(0, 12)}...</code>`
          : 'No snipes today';

        const dashboard = [
          '🧪 <b>LABORATORY STATUS</b>',
          '━━━━━━━━━━━━━━━',
          `📡 Active Whales: <b>${stats.activeWhales}</b>`,
          `📊 Alerts (24h): <b>${stats.alertsLast24h}</b>`,
          `🔥 Most Active: <b>${mostActive}</b>`,
          `🎯 Sniper of the Day: <b>${sniper}</b>`,
          '━━━━━━━━━━━━━━━',
          "Time to hunt some X's! 🚀",
        ].join('\n');

        await ctx.reply(dashboard, { parse_mode: 'HTML' });
      } catch {
        await ctx.reply('❌ Error loading laboratory stats.');
      }
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

  private registerTradingCallbacks() {
    this.bot.callbackQuery(/virtual_buy_(.+)_(.+)/, async (ctx) => {
      await ctx.answerCallbackQuery().catch(() => {});
      const tokenMint = ctx.match[1];
      const entryPrice = parseFloat(ctx.match[2]);
      const tgId = ctx.from.id.toString();

      const detail = await this.whalesService.getWhaleStats(tokenMint);

      const result = await this.tradingService.enterTrade(
        tgId,
        tokenMint,
        undefined,
        entryPrice,
      );
      await ctx.reply(result.message);
    });

    this.bot.callbackQuery(/virtual_sell_(.+)_(.+)/, async (ctx) => {
      await ctx.answerCallbackQuery().catch(() => {});
      const tokenMint = ctx.match[1];
      const exitPrice = parseFloat(ctx.match[2]);
      const tgId = ctx.from.id.toString();

      const result = await this.tradingService.closeTrade(
        tgId,
        tokenMint,
        exitPrice,
      );
      await ctx.reply(result.message);
    });

    this.bot.callbackQuery(/refresh_trade_(.+)/, async (ctx) => {
      await ctx.answerCallbackQuery('Refreshing...').catch(() => {});
      const tokenMint = ctx.match[1];
      const tgId = ctx.from.id.toString();

      const metadata = await this.whalesService.getTokenMetadata(tokenMint);
      if (!metadata) return;

      const trade = await (
        this.tradingService as any
      ).prisma.virtualTrade.findFirst({
        where: {
          user: { telegramId: tgId },
          tokenMint,
          status: 'OPEN',
        },
      });

      if (!trade) {
        return ctx.reply('❌ No open virtual position found for this token.');
      }

      const pnlPercent =
        ((metadata.priceUsd - trade.entryPrice) / trade.entryPrice) * 100;
      const pnlUAH = (trade.amountUAH * pnlPercent) / 100;
      const emoji = pnlPercent >= 0 ? '📈' : '📉';

      const lines = [
        `🔄 <b>LIVE UPDATE: ${metadata.symbol || ''}</b>`,
        '',
        `💎 <b>Token:</b> <code>${tokenMint}</code>`,
        `💰 <b>Entry:</b> ${trade.entryPrice.toFixed(8)}`,
        `💵 <b>Current:</b> ${metadata.priceUsd.toFixed(8)}`,
        '━━━━━━━━━━━━━━━',
        `${emoji} <b>Profit:</b> ${pnlPercent.toFixed(2)}%`,
        `💵 <b>PnL (UAH):</b> ${pnlUAH.toFixed(2)} UAH`,
        '━━━━━━━━━━━━━━━',
      ];

      const keyboard = new InlineKeyboard()
        .url('📈 DexScreener', `https://dexscreener.com/solana/${tokenMint}`)
        .url('🛡 RugCheck', `https://rugcheck.xyz/tokens/${tokenMint}`)
        .row()
        .url(
          '🤖 Trojan Bot',
          `https://t.me/solana_trojanbot?start=r-max-${tokenMint}`,
        )
        .text('🔄 Refresh Status', `refresh_trade_${tokenMint}`)
        .row()
        .text(
          '📉 Close Virtual Position',
          `virtual_sell_${tokenMint}_${metadata.priceUsd}`,
        );

      await ctx.editMessageText(lines.join('\n'), {
        parse_mode: 'HTML',
        reply_markup: keyboard,
      });
    });
  }

  private async sendPortfolio(ctx: any) {
    const tgId = ctx.from.id.toString();
    const portfolio = await this.tradingService.getUserPortfolio(tgId);

    let totalOpenValueUSD = 0;
    let totalPnLUAH = 0;
    const positionLines: string[] = [];

    for (const trade of portfolio.openTrades) {
      const metadata = await this.whalesService.getTokenMetadata(
        trade.tokenMint,
      );
      const currentPrice = metadata?.priceUsd || trade.entryPrice;
      const pnlPercent =
        ((currentPrice - trade.entryPrice) / trade.entryPrice) * 100;
      const pnlUAH = (trade.amountUAH * pnlPercent) / 100;

      totalPnLUAH += pnlUAH;
      const emoji = pnlPercent >= 0 ? '🟢' : '🔴';

      positionLines.push(
        `${emoji} <b>${trade.symbol || trade.tokenMint.slice(0, 4)}</b>: ${pnlPercent.toFixed(1)}% (${pnlUAH > 0 ? '+' : ''}${pnlUAH.toFixed(0)} UAH)`,
      );
    }

    const netWorth =
      portfolio.virtualBalance +
      portfolio.openTrades.length * 500 +
      totalPnLUAH;

    const text = [
      '🏦 <b>VIRTUAL PORTFOLIO</b>',
      '━━━━━━━━━━━━━━━',
      `💰 Balance: <b>${portfolio.virtualBalance.toFixed(2)} UAH</b>`,
      `📊 Open PnL: <b>${totalPnLUAH > 0 ? '+' : ''}${totalPnLUAH.toFixed(2)} UAH</b>`,
      `💎 Net Worth: <b>${netWorth.toFixed(2)} UAH</b>`,
      '',
      '📂 <b>Open Positions:</b>',
      positionLines.length > 0 ? positionLines.join('\n') : 'No open positions',
      '━━━━━━━━━━━━━━━',
    ].join('\n');

    await ctx.reply(text, { parse_mode: 'HTML' });
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

  private startWhaleMonitoring() {
    this.logger.log(
      `[MONITOR] Whale monitoring started (interval: ${BotService.TRACK_INTERVAL_MS / 1000}s)`,
    );

    this.monitorInterval = setInterval(async () => {
      if (this.isTracking) {
        this.logger.warn(
          '[MONITOR] Previous tracking cycle still running, skipping',
        );
        return;
      }

      this.isTracking = true;
      try {
        const alerts = await this.whalesService.trackWhales();
        await this.sendAlerts(alerts);
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        this.logger.error(`[MONITOR] Tracking cycle failed: ${message}`);
      } finally {
        this.isTracking = false;
      }
    }, BotService.TRACK_INTERVAL_MS);
  }

  private async sendAlerts(alerts: WhaleAlert[]) {
    if (alerts.length === 0) return;

    for (const alert of alerts) {
      const isBuy = alert.type === 'BUY';
      const typeEmoji = isBuy ? '🟢' : '🔴';
      const typeText = isBuy ? 'BOUGHT' : 'SOLD';
      const symbol = alert.tokenSymbol ? `<b>(${alert.tokenSymbol})</b>` : '';
      const usdAmount = alert.amountUSD
        ? ` (≈$${alert.amountUSD.toFixed(2)})`
        : '';

      const highValueEmoji =
        alert.amountUSD && alert.amountUSD > 1000 ? '🔥🏢 ' : '';

      const lines = [
        `${highValueEmoji}${typeEmoji} <b>WHALE ${typeText}!</b>`,
        '',
        `👤 <b>Whale:</b> ${alert.whaleName}`,
        `💎 <b>Token:</b> ${symbol} <code>${alert.tokenMint}</code>`,
        `💵 <b>Amount:</b> ${alert.amount.toFixed(2)}${usdAmount}`,
        '',
        `📈 <b>Whale History (24h):</b> ${alert.tradesLast24h} trade(s)`,
      ];

      const keyboard = new InlineKeyboard()
        .url(
          '📈 DexScreener',
          `https://dexscreener.com/solana/${alert.tokenMint}`,
        )
        .url('🛡 RugCheck', `https://rugcheck.xyz/tokens/${alert.tokenMint}`)
        .row()
        .url(
          '🤖 Trojan Bot',
          `https://t.me/solana_trojanbot?start=r-max-${alert.tokenMint}`,
        )
        .url('🔍 Solscan', `https://solscan.io/account/${alert.whaleAddress}`)
        .row();

      if (isBuy) {
        const price =
          alert.amountUSD && alert.amount ? alert.amountUSD / alert.amount : 0;

        keyboard.text(
          '🚀 Virtual Entry (500 UAH)',
          `virtual_buy_${alert.tokenMint}_${price}`,
        );
      } else {
        const hasPosition = await this.tradingService.hasOpenPosition(
          this.myTelegramId,
          alert.tokenMint,
        );
        if (hasPosition) {
          const price =
            alert.amountUSD && alert.amount
              ? alert.amountUSD / alert.amount
              : 0;
          keyboard.text(
            '🔄 Refresh Status',
            `refresh_trade_${alert.tokenMint}`,
          );
          keyboard.text(
            '📉 Close Virtual Position',
            `virtual_sell_${alert.tokenMint}_${price}`,
          );

          lines[0] = `‼️ <b>URGENT: WHALE SOLD!</b>`;
        }
      }

      await this.bot.api.sendMessage(this.myTelegramId, lines.join('\n'), {
        parse_mode: 'HTML',
        reply_markup: keyboard,
        link_preview_options: { is_disabled: true },
      });
    }
  }
}
