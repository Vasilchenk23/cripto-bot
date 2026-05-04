import {
  Injectable,
  Logger,
  OnModuleInit,
  Inject,
  forwardRef,
} from '@nestjs/common';
import { WhaleSocketService } from './whale-socket.service';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service';
import axios, { AxiosInstance } from 'axios';
import {
  RpcResponse,
  TokenBalance,
  TransactionResult,
} from './whales.interfaces';
import { TARGET_WHALE_ADDRESS } from '../config/constants';

const BASE58_REGEX = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

@Injectable()
export class WhalesService implements OnModuleInit {
  private readonly logger = new Logger(WhalesService.name);
  private readonly http: AxiosInstance;
  private readonly rpcUrl: string;

  private static readonly MIN_TOKEN_AMOUNT = 1e-6;
  public static readonly STABLECOINS = [
    'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
    'Es9vMFrzaDCSTMd377BmsC89sXnRNVptJmCi7yFSKmJC',
  ];

  constructor(
    private readonly configService: ConfigService,
    private readonly prisma: PrismaService,
    @Inject(forwardRef(() => WhaleSocketService))
    private readonly whaleSocketService: WhaleSocketService,
  ) {
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
    // Ensure the target whale exists in the DB
    await this.prisma.whale.upsert({
      where: { address: TARGET_WHALE_ADDRESS },
      update: { name: 'Target Whale', isActive: true },
      create: { address: TARGET_WHALE_ADDRESS, name: 'Target Whale', isActive: true },
    });
    this.logger.log(`[SEED] Initialized target whale: ${TARGET_WHALE_ADDRESS}`);
  }

  public isValidSolanaAddress(address: string): boolean {
    return BASE58_REGEX.test(address);
  }

  /**
   * Analyze a transaction signature for the target whale and return trade info.
   */
  public async analyzeSignature(
    signature: string,
  ): Promise<{ mint: string; symbol: string; side: string; priceUsd: number; amountUsd: number } | null> {
    try {
      const tx = await this.rpcCall<TransactionResult>('getTransaction', [
        signature,
        { encoding: 'jsonParsed', maxSupportedTransactionVersion: 0 },
      ]);
      if (!tx?.meta) return null;

      const preBalances: TokenBalance[] = tx.meta.preTokenBalances ?? [];
      const postBalances: TokenBalance[] = tx.meta.postTokenBalances ?? [];

      const mints = new Set([
        ...preBalances.map((b) => b.mint),
        ...postBalances.map((b) => b.mint),
      ]);

      for (const mint of mints) {
        if (WhalesService.STABLECOINS.includes(mint)) continue;
        
        const preBal = preBalances.find((p) => p.mint === mint && p.owner === TARGET_WHALE_ADDRESS);
        const postBal = postBalances.find((p) => p.mint === mint && p.owner === TARGET_WHALE_ADDRESS);
        
        const preAmount = preBal?.uiTokenAmount?.uiAmount ?? 0;
        const postAmount = postBal?.uiTokenAmount?.uiAmount ?? 0;
        const delta = postAmount - preAmount;
        
        if (Math.abs(delta) <= WhalesService.MIN_TOKEN_AMOUNT) continue;
        
        const side = delta > 0 ? 'BUY' : 'SELL';
        const absDelta = Math.abs(delta);
        const meta = await this.getTokenMetadata(mint);
        if (!meta) continue;

        const amountUsd = absDelta * meta.priceUsd;
        return { mint, symbol: meta.symbol, side, priceUsd: meta.priceUsd, amountUsd };
      }
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      this.logger.warn(`Failed to analyze signature ${signature}: ${message}`);
    }
    return null;
  }

  public async getTokenMetadata(mint: string): Promise<{
    symbol: string;
    priceUsd: number;
  } | null> {
    try {
      const { data } = await axios.get(
        `https://api.dexscreener.com/latest/dex/tokens/${mint}`,
      );
      if (data.pairs && data.pairs.length > 0) {
        const pair = data.pairs[0];
        return {
          symbol: pair.baseToken.symbol,
          priceUsd: parseFloat(pair.priceUsd),
        };
      }
    } catch (error: unknown) {
      // Fallback to Jupiter
      try {
        const { data: jupData } = await axios.get(
          `https://api.jup.ag/price/v2?ids=${mint}`,
        );
        if (jupData.data && jupData.data[mint]) {
          return {
            symbol: 'UNKNOWN',
            priceUsd: parseFloat(jupData.data[mint].price),
          };
        }
      } catch {}
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
    if (data.error) throw new Error(`RPC ${method} failed: ${data.error.message}`);
    return data.result as T;
  }
}
