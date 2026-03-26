import { Injectable } from '@nestjs/common';
import axios from 'axios';

@Injectable()
export class MarketService {
  async getTopPrices() {
    try {
      const response = await axios.get(
        'https://api.coingecko.com/api/v3/simple/price?ids=bitcoin,ethereum,solana&vs_currencies=usd&include_24hr_change=true',
      );

      const data = response.data;

      return (
        `💰 *Current Market Rates:* \n\n` +
        `🪙 *BTC:* $${data.bitcoin.usd.toLocaleString()} (${data.bitcoin.usd_24h_change.toFixed(2)}%)\n` +
        `💎 *ETH:* $${data.ethereum.usd.toLocaleString()} (${data.ethereum.usd_24h_change.toFixed(2)}%)\n` +
        `☀️ *SOL:* $${data.solana.usd.toLocaleString()} (${data.solana.usd_24h_change.toFixed(2)}%)`
      );
    } catch (error) {
      console.error('CoinGecko Error:', error);
      return '❌ Failed to fetch prices. Try again later.';
    }
  }
}
