import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaClient } from '@prisma/client';
import axios, { AxiosInstance } from 'axios';
import {
  RpcResponse,
  SignatureInfo,
  TokenBalance,
  TransactionResult,
  WhaleAlert,
  WhaleStats,
  WhaleListItem,
  WhaleDetail,
  GlobalStats,
} from './whales.interfaces';

const BASE58_REGEX = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

@Injectable()
export class WhalesService {
  private readonly logger = new Logger(WhalesService.name);
  private readonly prisma = new PrismaClient();
  private readonly http: AxiosInstance;
  private readonly rpcUrl: string;

  private static readonly MIN_TOKEN_AMOUNT = 1e-6;
  private static readonly SIGNATURE_LIMIT = 5;

  constructor(private readonly configService: ConfigService) {
    const apiKey = this.configService.getOrThrow<string>('HELIUS_API_KEY');
    this.rpcUrl = `https://mainnet.helius-rpc.com/?api-key=${apiKey}`;
    this.http = axios.create({
      baseURL: this.rpcUrl,
      timeout: 15_000,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  public isValidSolanaAddress(address: string): boolean {
    return BASE58_REGEX.test(address);
  }

  public async addWhale(address: string, name: string) {
    return this.prisma.whale.create({
      data: { address, name, isActive: true },
    });
  }

  public async getActiveWhales(): Promise<WhaleListItem[]> {
    const whales = await this.prisma.whale.findMany({
      where: { isActive: true },
      select: { id: true, name: true, address: true },
      orderBy: { createdAt: 'desc' },
    });
    return whales.map((w) => ({
      id: w.id,
      name: w.name ?? 'Unknown',
      address: w.address,
    }));
  }

  public async getWhaleDetail(id: number): Promise<WhaleDetail | null> {
    const whale = await this.prisma.whale.findUnique({
      where: { id },
      include: {
        transactions: {
          orderBy: { timestamp: 'desc' },
          distinct: ['tokenMint'],
          select: { tokenMint: true },
          take: 3,
        },
      },
    });

    if (!whale) return null;

    const totalTrades = await this.prisma.whaleTx.count({
      where: { whaleId: id },
    });

    return {
      id: whale.id,
      address: whale.address,
      name: whale.name ?? 'Unknown',
      isActive: whale.isActive,
      totalTrades,
      recentMints: whale.transactions.map((tx) => tx.tokenMint),
    };
  }

  public async deleteWhale(id: number): Promise<boolean> {
    const whale = await this.prisma.whale.findUnique({ where: { id } });
    if (!whale) return false;

    await this.prisma.whaleTx.deleteMany({ where: { whaleId: id } });
    await this.prisma.whale.delete({ where: { id } });
    return true;
  }

  public async getWhaleStats(address: string): Promise<WhaleStats> {
    const whale = await this.prisma.whale.findUnique({
      where: { address },
    });

    if (!whale) return { totalTrades: 0, recentMints: [] };

    const totalTrades = await this.prisma.whaleTx.count({
      where: { whaleId: whale.id },
    });

    const recentTxs = await this.prisma.whaleTx.findMany({
      where: { whaleId: whale.id },
      orderBy: { timestamp: 'desc' },
      distinct: ['tokenMint'],
      select: { tokenMint: true },
      take: 5,
    });

    return {
      totalTrades,
      recentMints: recentTxs.map((tx) => tx.tokenMint),
    };
  }

  public async getGlobalStats(): Promise<GlobalStats> {
    const activeWhales = await this.prisma.whale.count({
      where: { isActive: true },
    });

    const since24h = new Date(Date.now() - 24 * 60 * 60 * 1000);

    const alertsLast24h = await this.prisma.whaleTx.count({
      where: { timestamp: { gte: since24h } },
    });

    const topWhale = await this.prisma.whaleTx.groupBy({
      by: ['whaleId'],
      where: { whaleId: { not: null } },
      _count: { id: true },
      orderBy: { _count: { id: 'desc' } },
      take: 1,
    });

    let mostActiveWhale: GlobalStats['mostActiveWhale'] = null;
    if (topWhale.length > 0 && topWhale[0].whaleId !== null) {
      const whale = await this.prisma.whale.findUnique({
        where: { id: topWhale[0].whaleId },
      });
      if (whale) {
        mostActiveWhale = {
          name: whale.name ?? 'Unknown',
          tradeCount: topWhale[0]._count.id,
        };
      }
    }

    let sniperOfTheDay: GlobalStats['sniperOfTheDay'] = null;
    const earliestBuy = await this.prisma.whaleTx.findFirst({
      where: { timestamp: { gte: since24h }, type: 'BUY' },
      orderBy: { timestamp: 'asc' },
      include: { whale: true },
    });

    if (earliestBuy?.whale) {
      sniperOfTheDay = {
        name: earliestBuy.whale.name ?? 'Unknown',
        tokenMint: earliestBuy.tokenMint,
        timestamp: earliestBuy.timestamp,
      };
    }

    return { activeWhales, alertsLast24h, mostActiveWhale, sniperOfTheDay };
  }

  private async getTradesLast24h(whaleId: number): Promise<number> {
    const since24h = new Date(Date.now() - 24 * 60 * 60 * 1000);
    return this.prisma.whaleTx.count({
      where: { whaleId, timestamp: { gte: since24h } },
    });
  }

  public async trackWhales(): Promise<WhaleAlert[]> {
    const whales = await this.prisma.whale.findMany({
      where: { isActive: true },
    });
    const alerts: WhaleAlert[] = [];

    this.logger.log(`Checking ${whales.length} whales...`);

    for (const whale of whales) {
      try {
        const whaleAlerts = await this.processWhale(
          whale.id,
          whale.address.trim(),
          whale.name ?? 'Unknown',
        );
        alerts.push(...whaleAlerts);
      } catch (error: unknown) {
        const message =
          error instanceof Error ? error.message : String(error);
        this.logger.error(`Error tracking ${whale.address}: ${message}`);
      }
    }

    return alerts;
  }

  private async processWhale(
    whaleId: number,
    address: string,
    name: string,
  ): Promise<WhaleAlert[]> {
    const signatures = await this.rpcCall<SignatureInfo[]>(
      'getSignaturesForAddress',
      [address, { limit: WhalesService.SIGNATURE_LIMIT }],
    );

    if (!signatures || signatures.length === 0) {
      this.logger.debug(`${name}: No recent activity`);
      return [];
    }

    const lastSig = signatures[0];
    this.logger.log(
      `${name}: Latest sig ${lastSig.signature.slice(0, 12)}...`,
    );

    const exists = await this.prisma.whaleTx.findUnique({
      where: { signature: lastSig.signature },
    });
    if (exists) return [];

    const tx = await this.rpcCall<TransactionResult>('getTransaction', [
      lastSig.signature,
      { encoding: 'jsonParsed', maxSupportedTransactionVersion: 0 },
    ]);

    if (!tx?.meta) return [];

    return this.analyzeTransaction(tx, whaleId, address, name, lastSig.signature);
  }

  private async analyzeTransaction(
    tx: TransactionResult,
    whaleId: number,
    address: string,
    name: string,
    signature: string,
  ): Promise<WhaleAlert[]> {
    const preBalances: TokenBalance[] = tx.meta?.preTokenBalances ?? [];
    const postBalances: TokenBalance[] = tx.meta?.postTokenBalances ?? [];
    const alerts: WhaleAlert[] = [];

    for (const postBal of postBalances) {
      if (postBal.owner !== address) continue;

      const preBal = preBalances.find(
        (p) => p.owner === address && p.mint === postBal.mint,
      );

      const preAmount = preBal?.uiTokenAmount?.uiAmount ?? 0;
      const postAmount = postBal.uiTokenAmount?.uiAmount ?? 0;
      const delta = postAmount - preAmount;

      if (delta <= WhalesService.MIN_TOKEN_AMOUNT) continue;

      this.logger.warn(`[SIGNAL] ${name} bought ${postBal.mint} (+${delta})`);

      await this.prisma.whaleTx.create({
        data: {
          signature,
          tokenMint: postBal.mint,
          amount: delta,
          type: 'BUY',
          whaleId,
        },
      });

      const tradesLast24h = await this.getTradesLast24h(whaleId);

      alerts.push({
        whaleName: name,
        whaleAddress: address,
        tokenMint: postBal.mint,
        amount: delta,
        signature,
        tradesLast24h,
      });

      break;
    }

    return alerts;
  }

  private async rpcCall<T>(method: string, params: unknown[]): Promise<T> {
    const { data } = await this.http.post<RpcResponse<T>>('', {
      jsonrpc: '2.0',
      id: 1,
      method,
      params,
    });

    if (data.error) {
      throw new Error(`RPC ${method} failed: ${data.error.message}`);
    }

    return data.result as T;
  }
}
