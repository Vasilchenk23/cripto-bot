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
  private CHAT_ID: string;

  private async safeSendMessage(text: string, options: any = {}) {
    try {
      const statusKeyboard = new InlineKeyboard().text(
        '📊 Статус',
        'view_portfolio',
      );

      await this.bot.api.sendMessage(this.CHAT_ID, text, {
        parse_mode: 'HTML',
        reply_markup: statusKeyboard,
        ...options,
      });
    } catch (error) {
      this.logger.error(`[TELEGRAM] Failed to send message: ${error.message}`);
    }
  }

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
    this.CHAT_ID = this.myTelegramId;
    this.bot = new Bot(token);
  }

  async onModuleInit() {
    this.bot.catch((err) => this.logger.error(`Bot error: ${err.message}`));
    this.registerCommands();
    this.registerMenuHandlers();
    this.registerWhaleCallbacks();
    this.registerTradingCallbacks();

    this.whalesService.alert$.subscribe((alert) => {
      this.sendAlerts([alert]);
    });

    this.bot.start();
    this.logger.log('Bot started with real-time WebSocket monitoring');
  }

  onModuleDestroy() {}

  private registerCommands() {
    const mainMenu = new Keyboard().text('🏦 Портфолио').resized().persistent();

    this.bot.command('start', async (ctx) => {
      await ctx.reply(
        'Sup, Max! Crypto HQ is online. Use the button below to check your status.',
        {
          reply_markup: mainMenu,
        },
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

    this.bot.hears('🏦 Портфолио', async (ctx) => {
      await this.sendPortfolio(ctx);
    });

    this.bot.callbackQuery('view_portfolio', async (ctx) => {
      await ctx.answerCallbackQuery().catch(() => {});
      await this.sendPortfolio(ctx);
    });
  }

  private async handleAutoPilotToggle(ctx: any) {
    const tgId = ctx.from.id.toString();
    const result = await this.tradingService.toggleAutoPilot(tgId);

    if (result.enabled) {
      this.autoPilotSessionTrades.set(tgId, []);
      await ctx.reply(
        '🚀 <b>AUTO-PILOT ACTIVATED</b>\n\n- Amount: 500 UAH\n- Min Whale Buy: $1,000\n- Min Token Age: 15m\n\n<i>Go grab a coffee, I got this!</i> ☕',
        { parse_mode: 'HTML' },
      );
    } else {
      const sessionTrades = this.autoPilotSessionTrades.get(tgId) || [];
      this.autoPilotSessionTrades.delete(tgId);

      let report = '🛑 <b>AUTO-PILOT DEACTIVATED</b>\n\n';
      if (sessionTrades.length > 0) {
        report += `<b>Session Report:</b>\n`;
        report += sessionTrades
          .map((t) => `- Opened <code>${t.tokenMint.slice(0, 8)}...</code>`)
          .join('\n');
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

      this.logger.log(
        `[USER_ACTION] User ${tgId} clicked BUY ${amountUAH} UAH for txId ${txId}`,
      );
      await ctx.answerCallbackQuery().catch(() => {});

      try {
        const tx = await (this.whalesService as any).prisma.whaleTx.findUnique({
          where: { id: txId },
        });
        if (!tx) {
          this.logger.error(
            `[USER_ACTION] Transaction record ${txId} not found`,
          );
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
          this.logger.log(
            `[USER_ACTION] Trade entered successfully for ${tx.tokenMint}`,
          );
        } else {
          this.logger.warn(
            `[USER_ACTION] Trade entry failed: ${result.message}`,
          );
        }

        await ctx.reply(result.message);
      } catch (error: any) {
        this.logger.error(
          `[USER_ACTION] Error in BUY callback: ${error.message}`,
        );
        await ctx.reply('🔥 Critical error during trade entry.');
      }
    });

    this.bot.callbackQuery(/vs_(\d+)_(.+)/, async (ctx) => {
      const tgId = ctx.from.id.toString();
      const tradeId = parseInt(ctx.match[1], 10);
      const exitPrice = parseFloat(ctx.match[2]);

      this.logger.log(
        `[USER_ACTION] User ${tgId} clicked CLOSE for tradeId ${tradeId}`,
      );
      await ctx.answerCallbackQuery().catch(() => {});

      try {
        const trade = await (
          this.tradingService as any
        ).prisma.virtualTrade.findUnique({ where: { id: tradeId } });
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
          this.logger.log(
            `[USER_ACTION] Position closed successfully for ${trade.tokenMint}. PnL: ${result.pnlUAH} UAH`,
          );
        } else {
          this.logger.warn(
            `[USER_ACTION] Position closing failed: ${result.message}`,
          );
        }

        await ctx.reply(result.message);
      } catch (error: any) {
        this.logger.error(
          `[USER_ACTION] Error in CLOSE callback: ${error.message}`,
        );
        await ctx.reply('🔥 Critical error during position closing.');
      }
    });

    this.bot.callbackQuery(/rt_(\d+)/, async (ctx) => {
      const tgId = ctx.from.id.toString();
      const tradeId = parseInt(ctx.match[1], 10);

      this.logger.log(
        `[USER_ACTION] User ${tgId} clicked REFRESH for tradeId ${tradeId}`,
      );
      await ctx.answerCallbackQuery('Refreshing...').catch(() => {});

      const trade = await (
        this.tradingService as any
      ).prisma.virtualTrade.findUnique({
        where: { id: tradeId },
      });

      if (!trade || trade.status !== 'OPEN') {
        return ctx.reply('❌ No open virtual position found.');
      }

      const metadata = await this.whalesService.getTokenMetadata(
        trade.tokenMint,
      );
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
        .url(
          '📈 DexScreener',
          `https://dexscreener.com/solana/${trade.tokenMint}`,
        )
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
      keyboard
        .text(`❌ Close ${symbol}`, `vs_${trade.id}_${currentPrice.toFixed(8)}`)
        .row();
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
      reply_markup: keyboard,
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
      const tgId = this.myTelegramId;

      const user = await this.tradingService.getOrCreateUser(tgId);
      const isAutoPilot = (user as any).autoPilotEnabled;

      if (isBuy) {
        if (!isAutoPilot) {
          this.logger.log(
            `[WHALE] ${alert.whaleName} bought ${alert.tokenMint} but Auto-Pilot is OFF. Skipping.`,
          );
        } else {
          const lastEntry = this.cooldowns.get(alert.tokenMint) || 0;
          const cooldownMs = Date.now() - lastEntry;
          const cooldownActive = cooldownMs < 2 * 60 * 60 * 1000;
          const hasOpenPos = await this.tradingService.hasOpenPosition(
            tgId,
            alert.tokenMint,
          );

          const tokenAgeMin = alert.tokenAgeMin || 0;
          const isHighRisk = tokenAgeMin < 5;
          const minAgeMet = tokenAgeMin >= 15 || isHighRisk;
          const minAmountMet = (alert.amountUSD || 0) >= 1000;

          if (!minAgeMet) {
            this.logger.log(
              `[AUTO-PILOT] [SKIP] ${alert.tokenMint} ignored. Reason: Age ${tokenAgeMin}m (needs <5m or >=15m)`,
            );
          }
          if (!minAmountMet) {
            this.logger.log(
              `[AUTO-PILOT] [SKIP] ${alert.tokenMint} ignored. Reason: Amount < $1,000 ($${alert.amountUSD?.toFixed(0) || 0})`,
            );
          }
          if (cooldownActive) {
            this.logger.log(
              `[AUTO-PILOT] [SKIP] ${alert.tokenMint} ignored. Reason: Cooldown active (${Math.floor(cooldownMs / 60000)}m ago)`,
            );
          }
          if (hasOpenPos) {
            this.logger.log(
              `[AUTO-PILOT] [SKIP] ${alert.tokenMint} ignored. Reason: Position already open`,
            );
          }

          if (minAgeMet && minAmountMet && !cooldownActive && !hasOpenPos) {
            const entryAmount = isHighRisk ? 250 : 500;
            if (isHighRisk) {
              this.logger.warn(
                `[HIGH_RISK] Token ${alert.tokenMint} is too young (${alert.tokenAge || '0m'}), reducing entry amount to 250 UAH.`,
              );
            }

            this.logger.log(
              `[AUTO-PILOT] [BALANCE_CHECK] Current balance: ${user.virtualBalance.toFixed(2)}. Required: ${entryAmount}. Status: ${user.virtualBalance >= entryAmount ? 'OK' : 'FAIL'}`,
            );

            if (user.virtualBalance >= entryAmount) {
              const buyResult = await this.tradingService.enterTrade(
                tgId,
                alert.tokenMint,
                alert.tokenSymbol,
                alert.amountUSD! / alert.amount,
                entryAmount,
              );
              if (buyResult.success) {
                this.cooldowns.set(alert.tokenMint, Date.now());
                this.logger.log(
                  `[AUTO-PILOT] [ENTRY] Initial buy for token ${alert.tokenMint}. Amount: ${entryAmount} UAH. Reason: Whale bought $${alert.amountUSD?.toFixed(0)}`,
                );
                const session = this.autoPilotSessionTrades.get(tgId) || [];
                session.push({
                  tokenMint: alert.tokenMint,
                  timestamp: new Date(),
                });
                this.autoPilotSessionTrades.set(tgId, session);

                await this.safeSendMessage(
                  `✅ <b>Купил ${alert.tokenSymbol || alert.tokenMint.slice(0, 8)} на ${entryAmount} грн</b>${isHighRisk ? ' [HIGH_RISK]' : ''}`,
                );
              } else {
                this.logger.error(
                  `[AUTO-PILOT] [ERROR] Trade entry failed: ${buyResult.message}`,
                );
              }
            } else {
              this.logger.log(
                `[AUTO-PILOT] [SKIP] Insufficient balance for ${alert.tokenMint}`,
              );
            }
          }
        }
      }

      if (isBuy) {
        await this.checkWhaleAddOn(alert);
      } else {
        await this.handleFollowExit(alert);
      }
    }
  }

  private async checkWhaleAddOn(alert: WhaleAlert): Promise<void> {
    if (alert.type !== 'BUY') return;

    const tgId = this.myTelegramId;
    const user = await this.tradingService.getOrCreateUser(tgId);
    if (!(user as any).autoPilotEnabled) return;

    const openTrades = await this.tradingService.getOpenTrades();
    const trade = openTrades.find(
      (t) => t.tokenMint === alert.tokenMint && t.user.telegramId === tgId,
    );

    if (trade) {
      this.logger.log(
        `[AUTO-PILOT] [ADD-ON] Whale bought more! Checking balance for add-on...`,
      );
      this.logger.log(
        `[AUTO-PILOT] [BALANCE_CHECK] Current balance: ${user.virtualBalance.toFixed(2)}. Required: 500. Status: ${user.virtualBalance >= 500 ? 'OK' : 'FAIL'}`,
      );

      if (user.virtualBalance >= 500) {
        const price =
          alert.amountUSD && alert.amount
            ? alert.amountUSD / alert.amount
            : trade.entryPrice;
        const result = await this.tradingService.addToPosition(
          tgId,
          alert.tokenMint,
          price,
          500,
        );

        if (result.success) {
          const symbol = trade.symbol || alert.tokenMint.slice(0, 8);
          this.logger.log(
            `[AUTO-PILOT] [ADD-ON] Added 500 UAH to position ${alert.tokenMint}. New total: ${result.newAmount} UAH.`,
          );
          await this.safeSendMessage(
            `✅ <b>Увеличил позицию ${symbol} на 500 грн (Всего: ${result.newAmount})</b>`,
          );
        } else {
          this.logger.error(`[AUTO-PILOT] [ADD-ON] Error: ${result.message}`);
        }
      }
    }
  }

  private async handleFollowExit(alert: WhaleAlert) {
    if (alert.type !== 'SELL') return;

    const maxPos = alert.maxPositionUSD || 0;
    const soldAmountUSD = alert.amountUSD || 0;
    const soldPercent = maxPos > 0 ? (soldAmountUSD / maxPos) * 100 : 0;

    if (soldPercent < 50) {
      this.logger.log(
        `[EXIT_LOGIC] Whale sold $${soldAmountUSD.toFixed(0)}. Total whale position: $${maxPos.toFixed(0)}. Sold %: ${soldPercent.toFixed(1)}%. Threshold 50% NOT REACHED. Keeping position.`,
      );
      return;
    }

    this.logger.log(
      `[EXIT_LOGIC] Whale sold $${soldAmountUSD.toFixed(0)} (${soldPercent.toFixed(1)}% of max position), TRIGGERING AUTO-SELL.`,
    );

    const openTrades = await this.tradingService.getOpenTrades();
    const matchingTrades = openTrades.filter(
      (t) => t.tokenMint === alert.tokenMint,
    );

    for (const trade of matchingTrades) {
      const exitPrice =
        alert.amountUSD && alert.amount
          ? alert.amountUSD / alert.amount
          : trade.entryPrice;
      const result = await this.tradingService.closeTrade(
        trade.user.telegramId,
        trade.tokenMint,
        exitPrice,
      );

      if (result.success) {
        this.logger.log(
          `[AUTO-PILOT] [EXIT] Triggering auto-sell for ${trade.tokenMint}. Reason: Whale sold >50% (${soldPercent.toFixed(1)}%). PnL: ${result.pnlPercent?.toFixed(2)}% (${result.pnlUAH?.toFixed(2)} UAH).`,
        );

        const pnlUAH = result.pnlUAH || 0;
        const pnlSign = pnlUAH >= 0 ? '+' : '';
        await this.safeSendMessage(
          `✅ <b>Закрыл сделку. Профит: ${pnlSign}${pnlUAH.toFixed(0)} грн</b>`,
        );
      }
    }
  }
}
