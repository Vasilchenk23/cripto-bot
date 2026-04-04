import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaClient } from '@prisma/client';
import axios, { AxiosInstance } from 'axios';
import { Subject } from 'rxjs';
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
export class WhalesService implements OnModuleInit {
  private readonly logger = new Logger(WhalesService.name);
  private readonly prisma = new PrismaClient();
  private readonly http: AxiosInstance;
  private readonly rpcUrl: string;

  private whaleMaxPositions: Map<string, number> = new Map();
  public readonly alert$ = new Subject<WhaleAlert>();

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

  async onModuleInit() {
    await this.seedWhales();
  }

  private async seedWhales() {
    const raw = this.configService.get<string>('WHALE_ADDRESSES', '');
    if (!raw) {
      this.logger.warn('[SEED] WHALE_ADDRESSES not set in .env');
      return;
    }

    const entries = raw.split(',').map((entry) => {
      const colonIdx = entry.lastIndexOf(':');
      if (colonIdx === -1) return null;
      const name = entry.slice(0, colonIdx).trim();
      const address = entry.slice(colonIdx + 1).trim();
      return { name, address };
    }).filter(Boolean) as { name: string; address: string }[];

    for (const w of entries) {
      await this.prisma.whale.upsert({
        where: { address: w.address },
        update: { name: w.name, isActive: true },
        create: { address: w.address, name: w.name, isActive: true },
      });
    }
    this.logger.log(`[SEED] Upserted ${entries.length} whales from .env`);
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

    for (const whale of whales) {
      try {
        const whaleAlerts = await this.processWhale(
          whale.id,
          whale.address.trim(),
          whale.name ?? 'Unknown',
        );
        alerts.push(...whaleAlerts);
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
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

    if (!signatures || signatures.length === 0) return [];

    const lastSig = signatures[0];

    const exists = await this.prisma.whaleTx.findUnique({
      where: { signature: lastSig.signature },
    });
    if (exists) return [];

    const tx = await this.rpcCall<TransactionResult>('getTransaction', [
      lastSig.signature,
      { encoding: 'jsonParsed', maxSupportedTransactionVersion: 0 },
    ]);

    if (!tx?.meta) return [];

    return this.analyzeTransaction(
      tx,
      whaleId,
      address,
      name,
      lastSig.signature,
      Date.now(),
    );
  }

  private static readonly STABLECOINS = [
    'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
    'Es9vMFrzaDCSTMd377BmsC89sXnRNVptJmCi7yFSKmJC',
  ];

  private static readonly MIN_BUY_USD = 1000;
  private static readonly FAT_WHALE_USD = 5000;

  public async handleRealTimeTransaction(result: any) {
    const signalReceivedAt = Date.now();
    const signature = result.signature;
    const meta = result.transaction?.meta || result.meta;
    const slot = result.slot;
    const txData = result.transaction?.transaction || result.transaction;

    if (!txData || !meta) return;

    const accountKeys = txData.message?.accountKeys || [];
    if (accountKeys.length === 0) return;

    const addresses = accountKeys.map((k: any) => typeof k === 'string' ? k : k.pubkey);

    const whale = await this.prisma.whale.findFirst({
      where: {
        address: { in: addresses },
        isActive: true,
      },
    });

    if (!whale) return;

    const exists = await this.prisma.whaleTx.findUnique({
      where: { signature },
    });
    if (exists) return;

    await this.analyzeTransaction(
      { meta, slot, blockTime: Date.now() / 1000 },
      whale.id,
      whale.address,
      whale.name ?? 'Unknown',
      signature,
      signalReceivedAt,
    );
  }

  private async analyzeTransaction(
    tx: TransactionResult,
    whaleId: number,
    address: string,
    name: string,
    signature: string,
    signalReceivedAt: number = Date.now(),
  ): Promise<WhaleAlert[]> {
    const preBalances: TokenBalance[] = tx.meta?.preTokenBalances ?? [];
    const postBalances: TokenBalance[] = tx.meta?.postTokenBalances ?? [];
    const alerts: WhaleAlert[] = [];

    const mints = new Set([
      ...preBalances.filter((b) => b.owner === address).map((b) => b.mint),
      ...postBalances.filter((b) => b.owner === address).map((b) => b.mint),
    ]);

    for (const mint of mints) {
      if (WhalesService.STABLECOINS.includes(mint)) continue;

      const preBal = preBalances.find(
        (p) => p.owner === address && p.mint === mint,
      );
      const postBal = postBalances.find(
        (p) => p.owner === address && p.mint === mint,
      );

      const preAmount = preBal?.uiTokenAmount?.uiAmount ?? 0;
      const postAmount = postBal?.uiTokenAmount?.uiAmount ?? 0;
      const delta = postAmount - preAmount;

      if (Math.abs(delta) <= WhalesService.MIN_TOKEN_AMOUNT) continue;

      const type = delta > 0 ? 'BUY' : 'SELL';
      const absDelta = Math.abs(delta);

      const metadata = await this.getTokenMetadata(mint);
      if (!metadata) continue;

      const amountUSD = absDelta * metadata.priceUsd;

      if (type === 'BUY' && amountUSD < WhalesService.MIN_BUY_USD) continue;

      const isFatWhale = amountUSD >= WhalesService.FAT_WHALE_USD;

      const txRecord = await this.prisma.whaleTx.create({
        data: {
          signature,
          tokenMint: mint,
          amount: absDelta,
          amountUSD,
          priceAtTx: metadata.priceUsd,
          type,
          whaleId,
        },
      });

      const tradesLast24h = await this.getTradesLast24h(whaleId);

      const currentPositionUSD = postAmount * metadata.priceUsd;
      const posKey = `${address}:${mint}`;
      if (type === 'BUY') {
        const prevMax = this.whaleMaxPositions.get(posKey) || 0;
        if (currentPositionUSD > prevMax) {
          this.whaleMaxPositions.set(posKey, currentPositionUSD);
        }
      }
      const maxPositionUSD =
        this.whaleMaxPositions.get(posKey) || currentPositionUSD;

      const alert: WhaleAlert = {
        whaleName: name,
        whaleAddress: address,
        tokenMint: mint,
        tokenSymbol: metadata.symbol,
        amount: absDelta,
        amountUSD,
        type,
        signature,
        tradesLast24h,
        isFatWhale,
        tokenAge: metadata.tokenAge,
        tokenAgeMin: metadata.tokenAgeMin,
        txId: txRecord.id,
        preAmount,
        postAmount,
        maxPositionUSD,
        signalReceivedAt,
      };

      alerts.push(alert);
      this.alert$.next(alert);

      break;
    }

    return alerts;
  }

  public async getTokenMetadata(
    mint: string,
  ): Promise<{
    symbol: string;
    priceUsd: number;
    tokenAge?: string;
    tokenAgeMin?: number;
  } | null> {
    try {
      const { data } = await axios.get(
        `https://api.dexscreener.com/latest/dex/tokens/${mint}`,
      );
      if (data.pairs && data.pairs.length > 0) {
        const pair = data.pairs[0];
        const createdAt = pair.pairCreatedAt;
        let tokenAge = 'Unknown';
        let tokenAgeMin = 0;

        if (createdAt) {
          const ageMs = Date.now() - createdAt;
          tokenAgeMin = Math.floor(ageMs / (60 * 1000));
          const ageHours = Math.floor(tokenAgeMin / 60);
          const ageDays = Math.floor(ageHours / 24);

          if (ageDays > 0) tokenAge = `${ageDays}d`;
          else if (ageHours > 0) tokenAge = `${ageHours}h`;
          else tokenAge = `${tokenAgeMin}m`;
        }

        return {
          symbol: pair.baseToken.symbol,
          priceUsd: parseFloat(pair.priceUsd),
          tokenAge,
          tokenAgeMin,
        };
      }
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn(`DexScreener failed for ${mint}: ${message}`);

      try {
        const { data: jupData } = await axios.get(
          `https://api.jup.ag/price/v2?ids=${mint}`,
        );
        if (jupData.data && jupData.data[mint]) {
          return {
            symbol: 'UNKNOWN',
            priceUsd: parseFloat(jupData.data[mint].price),
            tokenAge: 'Unknown',
            tokenAgeMin: 0,
          };
        }
      } catch {
        this.logger.error(`Jupiter API also failed for ${mint}`);
      }
    }
    return null;
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
