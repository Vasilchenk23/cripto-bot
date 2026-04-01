import { PrismaClient } from '@prisma/client';
import * as fs from 'fs';
import * as path from 'path';

const prisma = new PrismaClient();

function getEnvValue(key: string): string | undefined {
  try {
    const envPath = path.join(process.cwd(), '.env');
    if (fs.existsSync(envPath)) {
      const envContent = fs.readFileSync(envPath, 'utf-8');
      const lines = envContent.split('\n');
      for (const line of lines) {
        const [k, v] = line.split('=');
        if (k?.trim() === key) {
          return v?.trim().replace(/^["']|["']$/g, '');
        }
      }
    }
  } catch (e) {
    console.error('Error reading .env:', e);
  }
  return process.env[key];
}

async function main() {
  const myTelegramId = getEnvValue('MY_TELEGRAM_ID');

  if (!myTelegramId) {
    console.error('❌ MY_TELEGRAM_ID not found in .env or process.env');
    return;
  }

  const user = await prisma.user.findUnique({
    where: { telegramId: myTelegramId },
  });

  if (!user) {
    console.log(`👤 User with ID ${myTelegramId} not found in DB. Creating new user with default balance.`);
    await prisma.user.create({
        data: {
            telegramId: myTelegramId,
            virtualBalance: 3500.0
        }
    });
    return;
  }

  const closedCount = await prisma.virtualTrade.updateMany({
    where: { userId: user.id, status: 'OPEN' },
    data: { status: 'CLOSED', closedAt: new Date() }
  });

  await prisma.user.update({
    where: { id: user.id },
    data: { virtualBalance: 3500.0 },
  });

  console.log(`✅ [PORTFOLIO_RESET] Closed ${closedCount.count} open trades.`);
  console.log(`✅ [BALANCE_FIX] Reset balance to 3500.00 UAH for user ${myTelegramId}.`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
