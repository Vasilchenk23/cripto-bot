import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { ConfigService } from '@nestjs/config';
import { WhaleSocketService } from './whale-socket.service';
import {
  MIN_WHALE_PNL_24H,
  MIN_WHALE_TRADES,
  MAX_TRACKED_WHALES,
} from '../config/constants';
import axios from 'axios';

interface WhaleCandidate {
  address: string;
  pnl24h: number;
  winRate?: number;
  trades?: number;
}

@Injectable()
export class WhaleDiscoveryService implements OnModuleInit {
  private readonly logger = new Logger(WhaleDiscoveryService.name);
  private readonly birdeyeKey: string | null;

  constructor(
    private readonly configService: ConfigService,
    private readonly whaleSocket: WhaleSocketService,
  ) {
    this.birdeyeKey = this.configService.get<string>('BIRDEYE_API_KEY') ?? null;
  }

  async onModuleInit() {
    await this.discoverWhales();
  }

  @Cron('0 */15 * * * *') // every 15 minutes
  async discoverWhales() {
    this.logger.log('[DISCOVERY] Fetching whale candidates...');

    const candidates = await this.fetchAllCandidates();
    const filtered = this.filterCandidates(candidates);

    this.logger.log(`[DISCOVERY] ${candidates.length} raw → ${filtered.length} qualified`);

    // Pass addresses directly — no DB storage
    this.whaleSocket.updateTrackedAddresses(filtered.map((c) => c.address));
  }

  // ─── Sources ──────────────────────────────────────────────────────────────

  private async fetchAllCandidates(): Promise<WhaleCandidate[]> {
    const results = await Promise.allSettled([
      this.fetchFromCielo(),
      this.fetchFromBirdeye(),
    ]);

    const all: WhaleCandidate[] = [];
    for (const r of results) {
      if (r.status === 'fulfilled') all.push(...r.value);
    }
    return all;
  }

  private async fetchFromCielo(): Promise<WhaleCandidate[]> {
    try {
      const { data } = await axios.get<unknown>(
        'https://feed.cielo.finance/api/v1/leaderboard',
        {
          params: { chain: 'solana', period: '1d', limit: 50 },
          timeout: 10_000,
          headers: { 'User-Agent': 'Mozilla/5.0', Accept: 'application/json' },
        },
      );

      const rows: unknown[] =
        (data as { data?: unknown[] })?.data ??
        (data as { results?: unknown[] })?.results ??
        (Array.isArray(data) ? data : []);

      return rows
        .filter((r): r is Record<string, unknown> => typeof r === 'object' && r !== null)
        .map((r) => ({
          address: String(r.address ?? r.wallet ?? r.user ?? ''),
          pnl24h: Number(r.realized_pnl ?? r.pnl ?? r.pnl_24h ?? 0),
          winRate: r.win_rate != null ? Number(r.win_rate) : undefined,
          trades: r.total_trades != null ? Number(r.total_trades) : undefined,
        }))
        .filter((c) => c.address.length > 30);
    } catch (e) {
      this.logger.warn(`[DISCOVERY][cielo] ${(e as Error).message}`);
      return [];
    }
  }

  private async fetchFromBirdeye(): Promise<WhaleCandidate[]> {
    if (!this.birdeyeKey) return [];
    try {
      const { data } = await axios.get<{
        success: boolean;
        data: { items: { address: string; pnl: number; trade_count: number; winRate?: number }[] };
      }>('https://public-api.birdeye.so/trader/gainers-losers', {
        params: { type: 'today', sort_by: 'PnL', sort_type: 'desc', limit: 10 },
        headers: { 'X-API-KEY': this.birdeyeKey, 'x-chain': 'solana' },
        timeout: 10_000,
      });

      if (!data?.success || !Array.isArray(data.data?.items)) return [];

      return data.data.items.map((item) => ({
        address: item.address,
        pnl24h: item.pnl,
        winRate: item.winRate,
        trades: item.trade_count,
      }));
    } catch (e) {
      this.logger.warn(`[DISCOVERY][birdeye] ${(e as Error).message}`);
      return [];
    }
  }

  // ─── Filter ───────────────────────────────────────────────────────────────

  private filterCandidates(raw: WhaleCandidate[]): WhaleCandidate[] {
    const byAddress = new Map<string, WhaleCandidate>();
    for (const c of raw) {
      const existing = byAddress.get(c.address);
      if (!existing || c.pnl24h > existing.pnl24h) {
        byAddress.set(c.address, c);
      }
    }

    return [...byAddress.values()]
      .filter(
        (c) =>
          c.pnl24h >= MIN_WHALE_PNL_24H &&
          (c.trades === undefined || c.trades >= MIN_WHALE_TRADES),
      )
      .sort((a, b) => b.pnl24h - a.pnl24h)
      .slice(0, MAX_TRACKED_WHALES);
  }
}
