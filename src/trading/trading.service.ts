import { Injectable, Logger } from '@nestjs/common';
import { PrismaClient, User, VirtualTrade } from '@prisma/client';

@Injectable()
export class TradingService {
  private readonly logger = new Logger(TradingService.name);
  private readonly prisma = new PrismaClient();

  private static readonly INITIAL_BALANCE = 3000.0;
  private static readonly DEFAULT_TRADE_AMOUNT = 750.0;

  async getOrCreateUser(telegramId: string): Promise<User> {
    const user = await this.prisma.user.findUnique({
      where: { telegramId },
    });

    if (user) return user;

    return this.prisma.user.create({
      data: {
        telegramId,
        virtualBalance: TradingService.INITIAL_BALANCE,
      },
    });
  }

  async toggleAutoPilot(telegramId: string): Promise<{ enabled: boolean }> {
    const user = await this.getOrCreateUser(telegramId);
    const updated = await this.prisma.user.update({
      where: { id: user.id },
      data: { autoPilotEnabled: !(user as any).autoPilotEnabled },
    });
    return { enabled: (updated as any).autoPilotEnabled };
  }

  async getOpenTradesCount(telegramId: string): Promise<number> {
    return this.prisma.virtualTrade.count({
      where: {
        user: { telegramId },
        status: 'OPEN',
      },
    });
  }

  async enterTrade(
    telegramId: string,
    tokenMint: string,
    symbol: string | undefined,
    entryPrice: number,
    amountUAH: number = TradingService.DEFAULT_TRADE_AMOUNT,
  ): Promise<{ success: boolean; message: string }> {
    const user = await this.getOrCreateUser(telegramId);

    if (user.virtualBalance < amountUAH) {
      return {
        success: false,
        message: `Insufficient virtual balance (need ${amountUAH} UAH).`,
      };
    }

    const existingTrade = await this.prisma.virtualTrade.findFirst({
      where: {
        userId: user.id,
        tokenMint,
        status: 'OPEN',
      },
    });

    if (existingTrade) {
      return {
        success: false,
        message: 'You already have an open virtual position for this token.',
      };
    }

    await this.prisma.$transaction([
      this.prisma.virtualTrade.create({
        data: {
          userId: user.id,
          tokenMint,
          symbol,
          entryPrice,
          amountUAH,
          status: 'OPEN',
        },
      }),
      this.prisma.user.update({
        where: { id: user.id },
        data: {
          virtualBalance: { decrement: amountUAH },
        },
      }),
    ]);

    return {
      success: true,
      message: `Virtual position opened successfully (${amountUAH} UAH)!`,
    };
  }

  async addToPosition(
    telegramId: string,
    tokenMint: string,
    price: number,
    amountUAH: number = 500.0,
  ): Promise<{ success: boolean; message: string; newAmount?: number }> {
    const user = await this.getOrCreateUser(telegramId);

    if (user.virtualBalance < amountUAH) {
      return {
        success: false,
        message: `Insufficient balance for add-on (${amountUAH} UAH).`,
      };
    }

    const trade = await this.prisma.virtualTrade.findFirst({
      where: { userId: user.id, tokenMint, status: 'OPEN' },
    });

    if (!trade) {
      return { success: false, message: 'No open position to add to.' };
    }

    const totalAmount = trade.amountUAH + amountUAH;
    const newEntryPrice =
      (trade.amountUAH * trade.entryPrice + amountUAH * price) / totalAmount;

    await this.prisma.$transaction([
      this.prisma.virtualTrade.update({
        where: { id: trade.id },
        data: {
          amountUAH: totalAmount,
          entryPrice: newEntryPrice,
        },
      }),
      this.prisma.user.update({
        where: { id: user.id },
        data: {
          virtualBalance: { decrement: amountUAH },
        },
      }),
    ]);

    return {
      success: true,
      message: `Added ${amountUAH} UAH to ${trade.symbol || 'token'}. Total: ${totalAmount} UAH.`,
      newAmount: totalAmount,
    };
  }

  async closeTrade(
    telegramId: string,
    tokenMint: string,
    exitPrice: number,
  ): Promise<{
    success: boolean;
    message: string;
    pnlUAH?: number;
    pnlPercent?: number;
  }> {
    const user = await this.getOrCreateUser(telegramId);

    const trade = await this.prisma.virtualTrade.findFirst({
      where: {
        userId: user.id,
        tokenMint,
        status: 'OPEN',
      },
    });

    if (!trade) {
      return {
        success: false,
        message: 'No open virtual position found for this token.',
      };
    }

    const pnlPercent =
      ((exitPrice - trade.entryPrice) / trade.entryPrice) * 100;
    const pnlUAH = (trade.amountUAH * pnlPercent) / 100;
    const finalReturn = trade.amountUAH + pnlUAH;

    await this.prisma.$transaction([
      this.prisma.virtualTrade.update({
        where: { id: trade.id },
        data: {
          status: 'CLOSED',
          exitPrice,
          pnlUAH,
          pnlPercent,
          closedAt: new Date(),
        },
      }),
      this.prisma.user.update({
        where: { id: user.id },
        data: {
          virtualBalance: { increment: finalReturn },
        },
      }),
    ]);

    return {
      success: true,
      message: `Position closed! PnL: ${pnlPercent.toFixed(2)}% (${pnlUAH.toFixed(2)} UAH)`,
      pnlUAH,
      pnlPercent,
    };
  }

  async hasOpenPosition(
    telegramId: string,
    tokenMint: string,
  ): Promise<boolean> {
    const user = await this.prisma.user.findUnique({ where: { telegramId } });
    if (!user) return false;

    const trade = await this.prisma.virtualTrade.findFirst({
      where: { userId: user.id, tokenMint, status: 'OPEN' },
    });

    return !!trade;
  }

  async getOpenTrades(): Promise<(VirtualTrade & { user: User })[]> {
    return this.prisma.virtualTrade.findMany({
      where: { status: 'OPEN' },
      include: { user: true },
    });
  }

  async getUserPortfolio(telegramId: string): Promise<{
    virtualBalance: number;
    openTrades: any[];
    totalNetWorth: number;
    totalPnLUAH: number;
    totalPnLPercent: number;
  }> {
    const user = await this.getOrCreateUser(telegramId);
    const openTrades = await this.prisma.virtualTrade.findMany({
      where: { userId: user.id, status: 'OPEN' },
    });

    return {
      virtualBalance: user.virtualBalance,
      openTrades,
      totalNetWorth: 0,
      totalPnLUAH: 0,
      totalPnLPercent: 0,
    };
  }
}
