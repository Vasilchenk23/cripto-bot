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
  AccountKey,
} from './whales.interfaces';
import { SOL_PRICE_REFRESH_MS } from '../config/constants';

const BASE58_REGEX = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const LAMPORTS = 1e9;
const MIN_SOL_SWAP = 0.005; // ignore dust moves < 0.005 SOL

export interface TradeInfo {
  mint: string;
  symbol: string;
  side: string;
  priceUsd: number;
  amountUsd: number;
  sellPercent: number;
}

@Injectable()
export class WhalesService implements OnModuleInit {
  private readonly logger = new Logger(WhalesService.name);
  private readonly http: AxiosInstance;
  private readonly rpcUrl: string;

  private static readonly MIN_TOKEN_AMOUNT = 1e-6;
  public static readonly STABLECOINS = [
    'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', // USDC
    'Es9vMFrzaDCSTMd377BmsC89sXnRNVptJmCi7yFSKmJC',  // USDT
  ];

  // SOL price cache
  private solPriceUsd = 150;
  private lastSolPriceMs = 0;

  // Token metadata cache — avoids DexScreener call on every repeated swap
  private readonly tokenMetaCache = new Map<string, { symbol: string; priceUsd: number; cachedAt: number }>();
  private static readonly TOKEN_CACHE_TTL_MS = 10_000;

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
    await this.refreshSolPrice();
  }

  public isValidSolanaAddress(address: string): boolean {
    return BASE58_REGEX.test(address);
  }

  // ─── SOL price ────────────────────────────────────────────────────────────

  public async getSolPrice(): Promise<number> {
    const now = Date.now();
    if (now - this.lastSolPriceMs < SOL_PRICE_REFRESH_MS) return this.solPriceUsd;
    await this.refreshSolPrice();
    return this.solPriceUsd;
  }

  private async refreshSolPrice() {
    try {
      const { data } = await axios.get(
        'https://api.binance.com/api/v3/ticker/price?symbol=SOLUSDT',
        { timeout: 5_000 },
      );
      this.solPriceUsd = parseFloat(data.price as string);
      this.lastSolPriceMs = Date.now();
      this.logger.debug(`[SOL] Price updated: $${this.solPriceUsd}`);
    } catch {
      // keep cached value
    }
  }

  // ─── analyzeSignature ─────────────────────────────────────────────────────

  public async analyzeSignature(
    signature: string,
    whaleAddress: string,
  ): Promise<TradeInfo | null> {
    const sig8 = signature.slice(0, 8);
    const addr8 = whaleAddress.slice(0, 8);

    // With processed commitment tx is available almost immediately
    let tx: TransactionResult | null = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      if (attempt > 0) await new Promise((r) => setTimeout(r, 400));
      try {
        tx = await this.rpcCall<TransactionResult>('getTransaction', [
          signature,
          { encoding: 'jsonParsed', maxSupportedTransactionVersion: 0, commitment: 'processed' },
        ]);
        if (tx?.meta) break;
        this.logger.debug(`[${sig8}] Tx not indexed yet (attempt ${attempt + 1})`);
      } catch (e) {
        this.logger.warn(`[${sig8}] RPC error (attempt ${attempt + 1}): ${(e as Error).message}`);
      }
    }

    if (!tx?.meta) {
      this.logger.warn(`[${sig8}] Tx unavailable after retries — skipping`);
      return null;
    }

    if (tx.meta.err) {
      this.logger.debug(`[${sig8}] Tx failed on-chain, skipping`);
      return null;
    }

    const preTokenBalances: TokenBalance[] = tx.meta.preTokenBalances ?? [];
    const postTokenBalances: TokenBalance[] = tx.meta.postTokenBalances ?? [];

    // Collect all mints present in the transaction
    const mints = new Set([
      ...preTokenBalances.map((b) => b.mint),
      ...postTokenBalances.map((b) => b.mint),
    ]);

    if (mints.size === 0) {
      this.logger.debug(`[${sig8}] No token balances — not a token swap`);
      return null;
    }

    const solPrice = await this.getSolPrice();

    for (const mint of mints) {
      if (WhalesService.STABLECOINS.includes(mint)) continue;

      const preBal = preTokenBalances.find(
        (p) => p.mint === mint && p.owner === whaleAddress,
      );
      const postBal = postTokenBalances.find(
        (p) => p.mint === mint && p.owner === whaleAddress,
      );

      const preAmount = preBal?.uiTokenAmount?.uiAmount ?? 0;
      const postAmount = postBal?.uiTokenAmount?.uiAmount ?? 0;
      const delta = postAmount - preAmount;

      if (Math.abs(delta) <= WhalesService.MIN_TOKEN_AMOUNT) continue;

      const side = delta > 0 ? 'BUY' : 'SELL';
      const absDelta = Math.abs(delta);

      this.logger.log(
        `[${sig8}] ${addr8} ${side} ${mint.slice(0, 8)}... Δ=${absDelta.toFixed(4)}`,
      );

      // ── Price resolution: tx-native → stablecoin → DexScreener ──────────
      let priceUsd: number | null = null;
      let symbol = 'UNKNOWN';

      // Method 1: calculate from native SOL balance change (fastest, works for new tokens)
      const solPrice1 = this.calcPriceFromSol(tx, whaleAddress, absDelta, side, solPrice);
      if (solPrice1 !== null) {
        priceUsd = solPrice1;
        this.logger.log(`[${sig8}] Price from SOL tx: $${priceUsd.toFixed(8)}`);
      }

      // Method 2: calculate from stablecoin balance change (USDC/USDT swap)
      if (priceUsd === null) {
        const stablePrice = this.calcPriceFromStablecoins(
          preTokenBalances, postTokenBalances, whaleAddress, absDelta,
        );
        if (stablePrice !== null) {
          priceUsd = stablePrice;
          this.logger.log(`[${sig8}] Price from stablecoin: $${priceUsd.toFixed(8)}`);
        }
      }

      // Method 3: fallback to DexScreener / Jupiter (slower, needed for symbol too)
      const meta = await this.getTokenMetadata(mint);
      if (meta) {
        symbol = meta.symbol;
        if (priceUsd === null) {
          priceUsd = meta.priceUsd;
          this.logger.log(`[${sig8}] Price from DexScreener: $${priceUsd.toFixed(8)}`);
        }
      }

      if (priceUsd === null || priceUsd <= 0) {
        this.logger.warn(`[${sig8}] Could not resolve price for ${mint.slice(0, 8)} — skipping`);
        continue;
      }

      const amountUsd = absDelta * priceUsd;
      const sellPercent =
        side === 'SELL' && preAmount > 0 ? absDelta / preAmount : 1.0;

      this.logger.log(
        `[${sig8}] → ${side} ${symbol} $${priceUsd.toFixed(8)} vol=$${amountUsd.toFixed(2)}`,
      );

      return { mint, symbol, side, priceUsd, amountUsd, sellPercent };
    }

    this.logger.debug(`[${sig8}] No relevant token movement for ${addr8}`);
    return null;
  }

  // ─── Price helpers ────────────────────────────────────────────────────────

  private calcPriceFromSol(
    tx: TransactionResult,
    whaleAddress: string,
    tokenDelta: number,
    side: string,
    solPrice: number,
  ): number | null {
    const keys = tx.transaction?.message?.accountKeys ?? [];
    const idx = keys.findIndex(
      (k) => (typeof k === 'string' ? k : (k as AccountKey).pubkey) === whaleAddress,
    );
    if (idx === -1 || !tx.meta) return null;

    const pre = tx.meta.preBalances[idx] ?? 0;
    const post = tx.meta.postBalances[idx] ?? 0;
    const fee = tx.meta.fee ?? 0;

    // Is this whale the fee payer? (usually the first signer = index 0)
    const firstKey = keys[0];
    const feePayerAddr =
      typeof firstKey === 'string' ? firstKey : (firstKey as AccountKey)?.pubkey;
    const feePaid = feePayerAddr === whaleAddress ? fee : 0;

    let solDelta: number;
    if (side === 'BUY') {
      solDelta = (pre - post - feePaid) / LAMPORTS;
    } else {
      solDelta = (post - pre + feePaid) / LAMPORTS;
    }

    if (solDelta < MIN_SOL_SWAP) return null;
    return (solDelta * solPrice) / tokenDelta;
  }

  private calcPriceFromStablecoins(
    pre: TokenBalance[],
    post: TokenBalance[],
    whaleAddress: string,
    tokenDelta: number,
  ): number | null {
    for (const stableMint of WhalesService.STABLECOINS) {
      const preBal = pre.find((b) => b.mint === stableMint && b.owner === whaleAddress);
      const postBal = post.find((b) => b.mint === stableMint && b.owner === whaleAddress);
      const preAmt = preBal?.uiTokenAmount?.uiAmount ?? 0;
      const postAmt = postBal?.uiTokenAmount?.uiAmount ?? 0;
      const usdcDelta = Math.abs(postAmt - preAmt);
      if (usdcDelta > 0.01) return usdcDelta / tokenDelta;
    }
    return null;
  }

  // ─── Token metadata ───────────────────────────────────────────────────────

  public async getTokenMetadata(mint: string): Promise<{
    symbol: string;
    priceUsd: number;
  } | null> {
    const cached = this.tokenMetaCache.get(mint);
    if (cached && Date.now() - cached.cachedAt < WhalesService.TOKEN_CACHE_TTL_MS) {
      return { symbol: cached.symbol, priceUsd: cached.priceUsd };
    }

    let result: { symbol: string; priceUsd: number } | null = null;

    // DexScreener
    try {
      const { data } = await axios.get(
        `https://api.dexscreener.com/latest/dex/tokens/${mint}`,
        { timeout: 5_000 },
      );
      if (data.pairs?.length > 0) {
        const pair = data.pairs[0];
        const price = parseFloat(pair.priceUsd);
        if (price > 0) {
          result = { symbol: pair.baseToken.symbol as string, priceUsd: price };
        }
      }
    } catch {
      // fall through to Jupiter
    }

    // Jupiter price API
    if (!result) {
      try {
        const { data: jupData } = await axios.get(
          `https://api.jup.ag/price/v2?ids=${mint}`,
          { timeout: 5_000 },
        );
        const entry = jupData?.data?.[mint];
        if (entry) {
          const price = parseFloat(entry.price as string);
          if (price > 0) result = { symbol: 'UNKNOWN', priceUsd: price };
        }
      } catch {
        // ignore
      }
    }

    if (result) {
      this.tokenMetaCache.set(mint, { ...result, cachedAt: Date.now() });
    }
    return result;
  }

  // ─── RPC helper ───────────────────────────────────────────────────────────

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
