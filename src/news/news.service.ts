import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios from 'axios';
import Parser = require('rss-parser');

@Injectable()
export class NewsService {
  private rssParser = new Parser({
    customFields: {
      item: [
        ['content:encoded', 'contentEncoded'],
        ['media:content', 'mediaContent'],
      ],
    },
  });

  constructor(private configService: ConfigService) {}

  async getGlobalHot() {
    const apiKey = this.configService.get<string>('CRYPTO_PANIC_KEY');
    if (!apiKey) return null;

    const plan =
      this.configService.get<string>('CRYPTO_PANIC_PLAN') || 'developer';
    const url = `https://cryptopanic.com/api/v1/posts/`;

    try {
      const { data } = await axios.get(url, {
        params: {
          auth_token: apiKey,
          filter: 'hot',
          kind: 'news',
          public: 'true',
        },
      });
      return data.results
        ?.slice(0, 10)
        .map((post: any) => ({ title: post.title, url: post.url }));
    } catch (e) {
      console.error('CryptoPanic API Error:', e.message);
      return null;
    }
  }

  async getLocalNews() {
    try {
      const feed = await this.rssParser.parseURL('https://incrypted.com/feed/');

      return feed.items.slice(0, 10).map((item: any) => {
        let imageUrl = '';

        if (
          item.mediaContent &&
          item.mediaContent.$ &&
          item.mediaContent.$.url
        ) {
          imageUrl = item.mediaContent.$.url;
        } else if (item.enclosure && item.enclosure.url) {
          imageUrl = item.enclosure.url;
        } else if (item.contentEncoded) {
          const lazyMatch = item.contentEncoded.match(
            /<img[^>]+data-lazy-src=["']([^"']+)["']/i,
          );
          const dataMatch = item.contentEncoded.match(
            /<img[^>]+data-src=["']([^"']+)["']/i,
          );
          const srcMatch = item.contentEncoded.match(
            /<img[^>]+src=["']([^"']+)["']/i,
          );

          imageUrl = lazyMatch?.[1] || dataMatch?.[1] || srcMatch?.[1] || '';

          if (
            imageUrl.includes('1x1') ||
            imageUrl.includes('transparent') ||
            imageUrl.includes('base64')
          ) {
            imageUrl = srcMatch?.[1] || '';
          }
        }

        const description =
          (item.contentSnippet || item.description || '')
            .replace(/<[^>]*>?/gm, '')
            .replace(/\n/g, ' ')
            .trim()
            .slice(0, 150) + '...';

        return {
          title: item.title || 'No title',
          url: item.link || '#',
          description: description,
          image: imageUrl,
        };
      });
    } catch (e) {
      console.error('RSS Parser Error:', e.message);
      return null;
    }
  }
}
