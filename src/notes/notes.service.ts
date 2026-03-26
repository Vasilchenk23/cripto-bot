import { Injectable } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';

@Injectable()
export class NotesService {
  private prisma = new PrismaClient();

  async createNote(text: string, link?: string) {
    return this.prisma.note.create({
      data: { text, link },
    });
  }

  async getAllNotes() {
    return this.prisma.note.findMany({
      orderBy: { createdAt: 'desc' },
    });
  }
}
