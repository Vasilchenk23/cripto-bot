# Solana Whale Tracker Bot

## Project Description
Solana Whale Tracker Bot is a NestJS based application that monitors large token transfers (whales) on the Solana blockchain in real time. It provides analytics, alerts, and a Telegram interface for users to query and manage tracked whale addresses.

## Tech Stack
- **Framework:** NestJS
- **Database:** PostgreSQL
- **ORM:** Prisma
- **Telegram Bot:** grammY
- **Blockchain RPC:** Helius RPC

## Getting Started
1. **Clone the repository**
   ```bash
   git clone <repository-url>
   cd crypto-bot
   ```
2. **Install dependencies**
   ```bash
   npm install
   ```
3. **Set up the database**
   Ensure PostgreSQL is running and the `DATABASE_URL` environment variable points to it.
4. **Run database migrations**
   ```bash
   npx prisma migrate deploy
   ```
5. **Start the application**
   ```bash
   npm run dev
   ```
   For production use the `start:prod` script which also runs migrations before launching the server.

## Environment Variables
| Variable          | Description                                          |
|-------------------|------------------------------------------------------|
| `DATABASE_URL`    | PostgreSQL connection string (e.g., `postgresql://...` ) |
| `BOT_TOKEN`       | Telegram bot token obtained from BotFather           |
| `HELIUS_API_KEY`  | API key for Helius RPC and WebSocket connections     |
| `MY_TELEGRAM_ID` | Telegram user ID that is allowed to run admin commands |

## Key Features
- **Real‑time monitoring** of whale transactions via Helius WebSocket.
- **Analytics** including peak profit calculations and trade statistics.
- **Security**: Administrative commands are restricted to a single `MY_TELEGRAM_ID`.
- **Scalable architecture** with a single global Prisma service to avoid connection pool exhaustion.
- **Rate‑limited DexScreener requests** to stay within external API limits.

## License
This project is provided under the MIT license.
