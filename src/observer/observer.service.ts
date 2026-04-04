import { Injectable, Logger } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { WhalesService } from '../whales/whales.service';
import axios from 'axios';

@Injectable()
export class ObserverService {
  private readonly logger = new Logger(ObserverService.name);
  private readonly prisma = new PrismaClient();

  constructor(private readonly whalesService: WhalesService) {}

  async recordTrade(params: {
    whaleId: number;
    tokenSymbol?: string;
    mintAddress: string;
    action: 'BUY' | 'SELL';
    usdAmount: number;
    entryPrice: number;
    signalReceivedAt: number;
  }) {
    const dbWrittenAt = Date.now();

    const trade = await this.prisma.observerTrade.create({
      data: {
        whaleId: params.whaleId,
        tokenSymbol: params.tokenSymbol ?? null,
        mintAddress: params.mintAddress,
        action: params.action,
        usdAmount: params.usdAmount,
        entryPrice: params.entryPrice,
        signalReceivedAt: BigInt(params.signalReceivedAt),
        dbWrittenAt: BigInt(dbWrittenAt),
      },
    });

    const latencyMs = dbWrittenAt - params.signalReceivedAt;
    this.logger.log(
      `[OBSERVER] Recorded ${params.action}: ${params.tokenSymbol || params.mintAddress.slice(0, 8)} $${params.usdAmount.toFixed(0)} (trade #${trade.id}, latency: ${latencyMs}ms)`,
    );

    if (params.action === 'BUY') {
      this.checkRugRisk(trade.id, params.mintAddress).catch((err) =>
        this.logger.warn(`[RUG_CHECK] Failed for ${params.mintAddress}: ${err.message}`),
      );
    }

    return trade;
  }

  private async checkRugRisk(tradeId: number, mintAddress: string) {
    try {
      const { data } = await axios.get(
        `https://api.rugcheck.xyz/v1/tokens/${mintAddress}/report/summary`,
        { timeout: 10_000 },
      );

      const isLocked =
        data?.score !== undefined ? data.score >= 500 : null;

      await this.prisma.observerTrade.update({
        where: { id: tradeId },
        data: { isLiquidityLocked: isLocked },
      });

      this.logger.log(
        `[RUG_CHECK] ${mintAddress.slice(0, 8)}: score=${data?.score ?? '?'}, locked=${isLocked}`,
      );
    } catch (error: any) {
      this.logger.warn(`[RUG_CHECK] API error for ${mintAddress.slice(0, 8)}: ${error.message}`);
    }
  }

  async updatePeakProfits() {
    const trades = await this.prisma.observerTrade.findMany({
      where: {
        action: 'BUY',
        OR: [
          { peak1m: null },
          { peak3m: null },
          { peak5m: null },
          { peak10m: null },
          { peak30m: null },
        ],
      },
    });

    if (trades.length === 0) return;

    for (const trade of trades) {
      try {
        const elapsedMs = Date.now() - trade.timestamp.getTime();
        const elapsedMin = elapsedMs / (60 * 1000);

        const intervals: { field: string; min: number }[] = [
          { field: 'peak1m', min: 1 },
          { field: 'peak3m', min: 3 },
          { field: 'peak5m', min: 5 },
          { field: 'peak10m', min: 10 },
          { field: 'peak30m', min: 30 },
        ];

        const updates: Record<string, number> = {};
        let needsPrice = false;

        for (const interval of intervals) {
          const currentVal = trade[interval.field as keyof typeof trade];
          if (currentVal === null && elapsedMin >= interval.min) {
            needsPrice = true;
            break;
          }
        }

        if (!needsPrice) continue;

        const metadata = await this.whalesService.getTokenMetadata(
          trade.mintAddress,
        );
        if (!metadata || metadata.priceUsd <= 0) continue;

        const currentProfitPercent =
          ((metadata.priceUsd - trade.entryPrice) / trade.entryPrice) * 100;

        for (const interval of intervals) {
          const currentVal = trade[interval.field as keyof typeof trade] as
            | number
            | null;
          if (currentVal === null && elapsedMin >= interval.min) {
            updates[interval.field] = currentProfitPercent;
          }
        }

        if (Object.keys(updates).length > 0) {
          await this.prisma.observerTrade.update({
            where: { id: trade.id },
            data: updates,
          });

          this.logger.log(
            `[OBSERVER] Updated peaks for trade #${trade.id} (${trade.tokenSymbol || trade.mintAddress.slice(0, 8)}): ${Object.entries(updates).map(([k, v]) => `${k}=${(v as number).toFixed(2)}%`).join(', ')}`,
          );
        }
      } catch (error: any) {
        this.logger.error(
          `[OBSERVER] Error updating peaks for trade #${trade.id}: ${error.message}`,
        );
      }
    }
  }

  async getAllTrades() {
    const trades = await this.prisma.observerTrade.findMany({
      include: { whale: { select: { name: true, address: true } } },
      orderBy: { timestamp: 'desc' },
    });

    return trades.map((t) => ({
      ...t,
      signalReceivedAt: Number(t.signalReceivedAt),
      dbWrittenAt: t.dbWrittenAt ? Number(t.dbWrittenAt) : null,
      latencyMs: t.dbWrittenAt
        ? Number(t.dbWrittenAt) - Number(t.signalReceivedAt)
        : null,
    }));
  }
}
