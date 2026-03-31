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
  private autoPilotSessionTrades = new Map<string, any[]>();
  private cooldowns = new Map<string, number>();

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
    
    // Real-time alerts subscription
    this.whalesService.alert$.subscribe((alert) => {
      this.sendAlerts([alert]);
    });

    this.bot.start();
    this.logger.log('Bot started with real-time WebSocket monitoring');
  }

  onModuleDestroy() {
    // No interval to clear anymore
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
      .row()
      .text('🤖 Toggle Auto-Pilot')
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

    this.bot.command('autopilot', async (ctx) => {
      await this.handleAutoPilotToggle(ctx);
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

    this.bot.hears('🤖 Toggle Auto-Pilot', async (ctx) => {
      await this.handleAutoPilotToggle(ctx);
    });
  }

  private async handleAutoPilotToggle(ctx: any) {
    const tgId = ctx.from.id.toString();
    const result = await this.tradingService.toggleAutoPilot(tgId);
    
    if (result.enabled) {
      this.autoPilotSessionTrades.set(tgId, []);
      await ctx.reply('🚀 <b>AUTO-PILOT ACTIVATED</b>\n\n- Amount: 500 UAH\n- Min Whale Buy: $1,000\n- Min Token Age: 15m\n\n<i>Go grab a coffee, I got this!</i> ☕', { parse_mode: 'HTML' });
    } else {
      const sessionTrades = this.autoPilotSessionTrades.get(tgId) || [];
      this.autoPilotSessionTrades.delete(tgId);
      
      let report = '🛑 <b>AUTO-PILOT DEACTIVATED</b>\n\n';
      if (sessionTrades.length > 0) {
        report += `<b>Session Report:</b>\n`;
        report += sessionTrades.map(t => `- Opened <code>${t.tokenMint.slice(0, 8)}...</code>`).join('\n');
      } else {
        report += 'No trades were made this session.';
      }
      
      await ctx.reply(report, { parse_mode: 'HTML' });
    }
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
    this.bot.callbackQuery(/vb_(\d+)_(.+)/, async (ctx) => {
      const tgId = ctx.from.id.toString();
      const txId = parseInt(ctx.match[1], 10);
      const amountUAH = parseFloat(ctx.match[2]);
      
      this.logger.log(`[USER_ACTION] User ${tgId} clicked BUY ${amountUAH} UAH for txId ${txId}`);
      await ctx.answerCallbackQuery().catch(() => {});

      try {
        const tx = await (this.whalesService as any).prisma.whaleTx.findUnique({ where: { id: txId } });
        if (!tx) {
          this.logger.error(`[USER_ACTION] Transaction record ${txId} not found`);
          return ctx.reply('❌ Transaction record not found.');
        }

        const result = await this.tradingService.enterTrade(
          tgId,
          tx.tokenMint,
          undefined,
          tx.priceAtTx || 0,
          amountUAH,
        );
        
        if (result.success) {
          this.cooldowns.set(tx.tokenMint, Date.now());
          this.logger.log(`[USER_ACTION] Trade entered successfully for ${tx.tokenMint}`);
        } else {
          this.logger.warn(`[USER_ACTION] Trade entry failed: ${result.message}`);
        }
        
        await ctx.reply(result.message);
      } catch (error: any) {
        this.logger.error(`[USER_ACTION] Error in BUY callback: ${error.message}`);
        await ctx.reply('🔥 Critical error during trade entry.');
      }
    });

    this.bot.callbackQuery(/vs_(\d+)_(.+)/, async (ctx) => {
      const tgId = ctx.from.id.toString();
      const tradeId = parseInt(ctx.match[1], 10);
      const exitPrice = parseFloat(ctx.match[2]);

      this.logger.log(`[USER_ACTION] User ${tgId} clicked CLOSE for tradeId ${tradeId}`);
      await ctx.answerCallbackQuery().catch(() => {});

      try {
        const trade = await (this.tradingService as any).prisma.virtualTrade.findUnique({ where: { id: tradeId } });
        if (!trade) {
          this.logger.error(`[USER_ACTION] Position ${tradeId} not found`);
          return ctx.reply('❌ Position not found.');
        }

        const result = await this.tradingService.closeTrade(
          tgId,
          trade.tokenMint,
          exitPrice,
        );
        
        if (result.success) {
          this.logger.log(`[USER_ACTION] Position closed successfully for ${trade.tokenMint}. PnL: ${result.pnlUAH} UAH`);
        } else {
          this.logger.warn(`[USER_ACTION] Position closing failed: ${result.message}`);
        }

        await ctx.reply(result.message);
      } catch (error: any) {
        this.logger.error(`[USER_ACTION] Error in CLOSE callback: ${error.message}`);
        await ctx.reply('🔥 Critical error during position closing.');
      }
    });

    this.bot.callbackQuery(/rt_(\d+)/, async (ctx) => {
      const tgId = ctx.from.id.toString();
      const tradeId = parseInt(ctx.match[1], 10);

      this.logger.log(`[USER_ACTION] User ${tgId} clicked REFRESH for tradeId ${tradeId}`);
      await ctx.answerCallbackQuery('Refreshing...').catch(() => {});

      const trade = await (this.tradingService as any).prisma.virtualTrade.findUnique({
        where: { id: tradeId },
      });

      if (!trade || trade.status !== 'OPEN') {
        return ctx.reply('❌ No open virtual position found.');
      }

      const metadata = await this.whalesService.getTokenMetadata(trade.tokenMint);
      if (!metadata) return;

      const pnlPercent =
        ((metadata.priceUsd - trade.entryPrice) / trade.entryPrice) * 100;
      const pnlUAH = (trade.amountUAH * pnlPercent) / 100;
      const emoji = pnlPercent >= 0 ? '📈' : '📉';

      const lines = [
        `🔄 <b>LIVE UPDATE: ${metadata.symbol || ''}</b>`,
        '',
        `💎 <b>Token:</b> <code>${trade.tokenMint}</code>`,
        `💰 <b>Entry:</b> ${trade.entryPrice.toFixed(8)}`,
        `💵 <b>Current:</b> ${metadata.priceUsd.toFixed(8)}`,
        '━━━━━━━━━━━━━━━',
        `${emoji} <b>Profit:</b> ${pnlPercent.toFixed(2)}%`,
        `💵 <b>PnL (UAH):</b> ${pnlUAH.toFixed(2)} UAH`,
        '━━━━━━━━━━━━━━━',
      ];

      const keyboard = new InlineKeyboard()
        .url('📈 DexScreener', `https://dexscreener.com/solana/${trade.tokenMint}`)
        .url('🛡 RugCheck', `https://rugcheck.xyz/tokens/${trade.tokenMint}`)
        .row()
        .url(
          '🤖 Trojan Bot',
          `https://t.me/solana_trojanbot?start=r-max-${trade.tokenMint}`,
        )
        .text('🔄 Refresh Status', `rt_${trade.id}`)
        .row()
        .text(
          '📉 Close Virtual Position',
          `vs_${trade.id}_${metadata.priceUsd.toFixed(8)}`,
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

    let totalPnLUAH = 0;
    const positionLines: string[] = [];
    const keyboard = new InlineKeyboard();

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
      const symbol = trade.symbol || trade.tokenMint.slice(0, 7);

      positionLines.push(
        `${emoji} <b>${symbol}</b>: ${pnlPercent.toFixed(1)}% (${pnlUAH > 0 ? '+' : ''}${pnlUAH.toFixed(0)} UAH)`,
      );

      // Add close button for this specific trade
      keyboard.text(`❌ Close ${symbol}`, `vs_${trade.id}_${currentPrice.toFixed(8)}`).row();
    }

    const netWorth =
      portfolio.virtualBalance +
      portfolio.openTrades.reduce((acc, t) => acc + t.amountUAH, 0) +
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

    await ctx.reply(text, { 
      parse_mode: 'HTML',
      reply_markup: keyboard
    });
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
    this.logger.log('[MONITOR] Real-time monitoring active via WebSockets');
  }

  private async sendAlerts(alerts: WhaleAlert[]) {
    if (alerts.length === 0) return;

    for (const alert of alerts) {
      const isBuy = alert.type === 'BUY';
      const tgId = this.myTelegramId; // Assuming single user for now as per TZ

      // Silence Mode Implementation
      if (!isBuy) {
        const hasPosition = await this.tradingService.hasOpenPosition(tgId, alert.tokenMint);
        if (!hasPosition) {
          this.logger.debug(`[SILENCE] Ignoring whale sell alert for ${alert.tokenMint} (no position)`);
          continue;
        }
      }

      // Auto-Pilot Implementation
      const user = await this.tradingService.getOrCreateUser(tgId);
      const lastEntry = this.cooldowns.get(alert.tokenMint) || 0;
      const cooldownMs = Date.now() - lastEntry;
      const cooldownActive = cooldownMs < 2 * 60 * 60 * 1000;
      const hasOpenPos = await this.tradingService.hasOpenPosition(tgId, alert.tokenMint);

      if (isBuy && (user as any).autoPilotEnabled) {
        const minAgeMet = (alert.tokenAgeMin || 0) >= 15;
        const minAmountMet = (alert.amountUSD || 0) >= 1000;
        
        // Detailed SKIP logging
        if (!minAgeMet) this.logger.log(`[AUTO-PILOT] [SKIP] ${alert.tokenMint} ignored. Reason: Age < 15m (${alert.tokenAge || '0m'})`);
        if (!minAmountMet) this.logger.log(`[AUTO-PILOT] [SKIP] ${alert.tokenMint} ignored. Reason: Amount < $1,000 ($${alert.amountUSD?.toFixed(0) || 0})`);
        if (cooldownActive) this.logger.log(`[AUTO-PILOT] [SKIP] ${alert.tokenMint} ignored. Reason: Cooldown active (${Math.floor(cooldownMs / 60000)}m ago)`);
        if (hasOpenPos) this.logger.log(`[AUTO-PILOT] [SKIP] ${alert.tokenMint} ignored. Reason: Position already open`);

        if (minAgeMet && minAmountMet && !cooldownActive && !hasOpenPos) {
          // Balance Check
          this.logger.log(`[AUTO-PILOT] [BALANCE_CHECK] Current balance: ${user.virtualBalance.toFixed(2)}. Required: 500. Status: ${user.virtualBalance >= 500 ? 'OK' : 'FAIL'}`);

          if (user.virtualBalance >= 500) {
            const buyResult = await this.tradingService.enterTrade(tgId, alert.tokenMint, alert.tokenSymbol, (alert.amountUSD! / alert.amount), 500);
            if (buyResult.success) {
              this.cooldowns.set(alert.tokenMint, Date.now());
              this.logger.log(`[AUTO-PILOT] [ENTRY] Initial buy for token ${alert.tokenMint}. Amount: 500 UAH. Reason: Whale bought $${alert.amountUSD?.toFixed(0)}`);
              const session = this.autoPilotSessionTrades.get(tgId) || [];
              session.push({ tokenMint: alert.tokenMint, timestamp: new Date() });
              this.autoPilotSessionTrades.set(tgId, session);
              
              await this.bot.api.sendMessage(tgId, `🤖 <b>AUTO-PILOT [ENTRY]:</b> Entered trade for <code>${alert.tokenMint}</code> (500 UAH)`, { parse_mode: 'HTML' });
            } else {
              this.logger.error(`[AUTO-PILOT] [ERROR] Trade entry failed: ${buyResult.message}`);
            }
          }
        }
      }
      const typeEmoji = isBuy ? '🟢' : '🔴';
      const typeText = isBuy ? 'BOUGHT' : 'SOLD';
      const symbol = alert.tokenSymbol ? `<b>(${alert.tokenSymbol})</b>` : '';
      const usdAmount = alert.amountUSD
        ? ` (≈$${alert.amountUSD.toFixed(2)})`
        : '';

      let header = isBuy ? `🟢 <b>WHALE ${typeText}!</b>` : `🔴 <b>WHALE ${typeText}!</b>`;
      if (alert.isFatWhale && isBuy) {
        header = `🚨🚨🚨 <b>ЖИРНЫЙ КИТ</b> 🚨🚨🚨`;
      }

      const lines = [
        header,
        '',
        `👤 <b>Whale:</b> ${alert.whaleName}`,
        `💎 <b>Token:</b> ${symbol} <code>${alert.tokenMint}</code>`,
        `💵 <b>Amount:</b> ${alert.amount.toFixed(2)}${usdAmount}`,
        `⏳ <b>Age:</b> ${alert.tokenAge || 'Unknown'}`,
        '',
        `📈 <b>Whale History (24h):</b> ${alert.tradesLast24h} trade(s)`,
      ];

      const keyboard = new InlineKeyboard()
        .url(
          '📈 DexScreener',
          `https://dexscreener.com/solana/${alert.tokenMint}`,
        )
        .row();

      if (isBuy) {
        const price = alert.amountUSD && alert.amount ? alert.amountUSD / alert.amount : 0;
        
        // Add-ON check
        await this.checkWhaleAddOn(alert);

        keyboard.text('300 грн', `vb_${alert.txId}_300`);
        keyboard.text('750 грн', `vb_${alert.txId}_750`);
        keyboard.text('1500 грн', `vb_${alert.txId}_1500`);
        keyboard.row();
      } else {
        // Follow-Exit Logic: If whale sells, auto-close our positions
        await this.handleFollowExit(alert);

        const hasPosition = await this.tradingService.hasOpenPosition(
          this.myTelegramId,
          alert.tokenMint,
        );
        if (hasPosition) {
          const price = alert.amountUSD && alert.amount ? alert.amountUSD / alert.amount : 0;
          const openTrades = await this.tradingService.getOpenTrades();
          const userTrade = openTrades.find(t => t.tokenMint === alert.tokenMint && t.user.telegramId === this.myTelegramId);
          
          if (userTrade) {
            keyboard.text('🔄 Refresh Status', `rt_${userTrade.id}`);
            keyboard.text('📉 Close Virtual Position', `vs_${userTrade.id}_${price.toFixed(8)}`);
            lines[0] = `‼️ <b>URGENT: WHALE SOLD!</b>`;
          }
        }
      }

      await this.bot.api.sendMessage(this.myTelegramId, lines.join('\n'), {
        parse_mode: 'HTML',
        reply_markup: keyboard,
        link_preview_options: { is_disabled: true },
      });
    }
  }

  private async checkWhaleAddOn(alert: WhaleAlert) {
    if (alert.type !== 'BUY') return;

    const tgId = this.myTelegramId;
    const user = await this.tradingService.getOrCreateUser(tgId);
    const openTrades = await this.tradingService.getOpenTrades();
    const trade = openTrades.find(t => t.tokenMint === alert.tokenMint && t.user.telegramId === tgId);

    if (trade) {
      const usdAmount = alert.amountUSD ? `≈$${alert.amountUSD.toFixed(2)}` : '';
      
      // Auto-Add-on Logic
      if ((user as any).autoPilotEnabled) {
        this.logger.log(`[AUTO-PILOT] [ADD-ON] Whale bought more! Checking balance for add-on...`);
        this.logger.log(`[AUTO-PILOT] [BALANCE_CHECK] Current balance: ${user.virtualBalance.toFixed(2)}. Required: 500. Status: ${user.virtualBalance >= 500 ? 'OK' : 'FAIL'}`);

        if (user.virtualBalance >= 500) {
          const price = alert.amountUSD && alert.amount ? alert.amountUSD / alert.amount : trade.entryPrice;
          const result = await this.tradingService.addToPosition(tgId, alert.tokenMint, price, 500);
          
          if (result.success) {
            this.logger.log(`[AUTO-PILOT] [ADD-ON] Added 500 UAH to position ${alert.tokenMint}. New total: ${result.newAmount} UAH.`);
            await this.bot.api.sendMessage(tgId, `🤖 <b>AUTO-PILOT [ADD-ON]:</b> Whale bought more! Added 500 UAH to <code>${alert.tokenMint}</code>. New total: <b>${result.newAmount} UAH</b>`, { parse_mode: 'HTML' });
            return;
          } else {
            this.logger.error(`[AUTO-PILOT] [ADD-ON] Error: ${result.message}`);
          }
        }
      }

      // If not auto-pilot or failed, just notify
      const text = [
        `⚠️ <b>КИТ ДОКУПИЛ!</b>`,
        `💎 Token: <code>${alert.tokenMint}</code>`,
        `💵 Новая сумма покупки кита: <b>${alert.amount.toFixed(2)} ${usdAmount}</b>`,
      ].join('\n');

      await this.bot.api.sendMessage(tgId, text, { parse_mode: 'HTML' });
    }
  }

  private async handleFollowExit(alert: WhaleAlert) {
    if (alert.type !== 'SELL') return;

    // Smart Exit: Only exit if whale sells > 50% of his position
    const pre = alert.preAmount || 0;
    const post = alert.postAmount || 0;
    const soldPercent = pre > 0 ? ((pre - post) / pre) * 100 : 0;

    if (soldPercent < 50 && post > 0) {
      this.logger.log(`[EXIT_LOGIC] Whale sold ${soldPercent.toFixed(1)}% of position, keeping position (Threshold is 50%). Remaining: ${post.toFixed(2)}`);
      return;
    }

    this.logger.log(`[EXIT_LOGIC] Whale sold ${soldPercent.toFixed(1)}% of position (post: ${post.toFixed(2)}), TRIGGERING AUTO-SELL.`);

    const openTrades = await this.tradingService.getOpenTrades();
    const matchingTrades = openTrades.filter(t => t.tokenMint === alert.tokenMint);

    for (const trade of matchingTrades) {
      const exitPrice = alert.amountUSD && alert.amount ? alert.amountUSD / alert.amount : trade.entryPrice;
      const result = await this.tradingService.closeTrade(trade.user.telegramId, trade.tokenMint, exitPrice);
      
      if (result.success) {
        this.logger.log(`[AUTO-PILOT] [EXIT] Triggering auto-sell for ${trade.tokenMint}. Reason: Whale sold >50% (${soldPercent.toFixed(1)}%). PnL: ${result.pnlPercent?.toFixed(2)}% (${result.pnlUAH?.toFixed(2)} UAH).`);
      }

      const text = [
        `🚨 <b>СДЕЛКА ЗАКРЫТА (FOLLOW-EXIT)</b>`,
        `💎 Token: ${trade.symbol || trade.tokenMint.slice(0, 8)}...`,
        `👤 Reason: Whale dumps >50% of position (${soldPercent.toFixed(1)}%)`,
        '━━━━━━━━━━━━━━━',
        `📊 Результат: <b>${result.pnlPercent?.toFixed(2)}%</b> (<b>${result.pnlUAH?.toFixed(2)} грн</b>)`,
        `💰 Текущий баланс: <b>${(await this.tradingService.getOrCreateUser(trade.user.telegramId)).virtualBalance.toFixed(2)} грн</b>`,
      ].join('\n');

      await this.bot.api.sendMessage(trade.user.telegramId, text, { parse_mode: 'HTML' });
    }
  }
}
