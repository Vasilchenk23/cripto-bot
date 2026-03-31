import { PrismaClient } from '@prisma/client';

async function main() {
  const prisma = new PrismaClient();
  try {
    const openTrades = await prisma.virtualTrade.findMany({
      where: { status: 'OPEN' },
      include: { user: true },
    });

    console.log(`Closing ${openTrades.length} open trades...`);

    for (const trade of openTrades) {
      await prisma.$transaction([
        prisma.virtualTrade.update({
          where: { id: trade.id },
          data: {
            status: 'CLOSED',
            exitPrice: trade.entryPrice,
            pnlUAH: 0,
            pnlPercent: 0,
            closedAt: new Date(),
          },
        }),
        prisma.user.update({
          where: { id: trade.userId },
          data: {
            virtualBalance: { increment: trade.amountUAH },
          },
        }),
      ]);
    }
    console.log('All trades closed and balances refunded (break-even).');
  } catch (error) {
    console.error('Error closing trades:', error);
  } finally {
    await prisma.$disconnect();
  }
}

main();
