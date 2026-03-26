import { Injectable } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';

@Injectable()
export class AirdropsService {
  private prisma = new PrismaClient();

  async getActiveAirdrops() {
    return this.prisma.airdrop.findMany({
      orderBy: { createdAt: 'desc' },
    });
  }
}
