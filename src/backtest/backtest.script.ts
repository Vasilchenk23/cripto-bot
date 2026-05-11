/**
 * Backtest script: replays all bot trades from the DB and computes P&L.
 *
 * Run: pnpm backtest
 *
 * Logic:
 *   - Loads all isBot=true trades ordered by timestamp.
 *   - Pairs BUY→SELL(s) per tokenMint chronologically.
 *   - P&L per sell = amountUsd (original cost basis sold) × (exitPrice / entryPrice − 1)
 *   - Reports per-trade log and summary stats.
 */

import { PrismaClient } from '@prisma/client';
import * as dotenv from 'dotenv';
import * as path from 'path';

dotenv.config({ path: path.resolve(process.cwd(), '.env') });

interface OpenPosition {
  entryPrice: number;
  costBasis: number;
  symbol: string;
}

async function main() {
  const prisma = new PrismaClient();

  try {
    const trades = await prisma.trade.findMany({
      where: { isBot: true },
      orderBy: { timestamp: 'asc' },
    });

    if (trades.length === 0) {
      console.log('No bot trades found in the database.');
      return;
    }

    const positions = new Map<string, OpenPosition>();
    let totalPnl = 0;
    let closedCount = 0;
    let wins = 0;
    let losses = 0;
    const log: string[] = [];

    for (const trade of trades) {
      const label = trade.tokenSymbol ?? trade.tokenMint.slice(0, 8);
      const date = trade.timestamp.toISOString().slice(0, 16).replace('T', ' ');

      if (trade.side === 'BUY') {
        positions.set(trade.tokenMint, {
          entryPrice: trade.priceUsd,
          costBasis: trade.amountUsd,
          symbol: label,
        });
        log.push(`${date}  OPEN   ${label.padEnd(10)} entry $${trade.priceUsd.toFixed(6)}  size $${trade.amountUsd.toFixed(2)}`);
        continue;
      }

      if (trade.side === 'SELL') {
        const pos = positions.get(trade.tokenMint);
        if (!pos) {
          log.push(`${date}  SELL   ${label.padEnd(10)} — no matching open position, skipped`);
          continue;
        }

        // P&L on the cost basis that was closed in this sell leg
        const pnl = trade.amountUsd * (trade.priceUsd / pos.entryPrice - 1);
        const pct = ((trade.priceUsd / pos.entryPrice - 1) * 100).toFixed(2);
        const sign = pnl >= 0 ? '+' : '';
        totalPnl += pnl;
        closedCount++;
        if (pnl >= 0) wins++; else losses++;

        log.push(
          `${date}  CLOSE  ${label.padEnd(10)} ${sign}${pct}%  pnl ${sign}$${pnl.toFixed(2)}  sold $${trade.amountUsd.toFixed(2)}`,
        );

        // Reduce remaining cost basis; remove position if fully closed
        const remaining = pos.costBasis - trade.amountUsd;
        if (remaining <= 0.001) {
          positions.delete(trade.tokenMint);
        } else {
          pos.costBasis = remaining;
        }
      }
    }

    console.log('\n=== Backtest Trade Log ===\n');
    for (const line of log) console.log(line);

    console.log('\n=== Summary ===');
    console.log(`Closed legs : ${closedCount}`);
    console.log(`Wins / Losses: ${wins} / ${losses}`);
    console.log(
      `Win rate    : ${closedCount > 0 ? ((wins / closedCount) * 100).toFixed(1) : '0.0'}%`,
    );
    console.log(
      `Total P&L   : ${totalPnl >= 0 ? '+' : ''}$${totalPnl.toFixed(2)}`,
    );

    if (positions.size > 0) {
      console.log(`\nOpen positions (${positions.size}):`);
      for (const [mint, pos] of positions) {
        console.log(
          `  ${pos.symbol.padEnd(10)} entry $${pos.entryPrice.toFixed(6)}  remaining $${pos.costBasis.toFixed(2)}  (${mint.slice(0, 8)}...)`,
        );
      }
    }
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
