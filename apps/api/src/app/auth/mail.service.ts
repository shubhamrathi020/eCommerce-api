import { Inject, Injectable, Logger } from '@nestjs/common';
import { API_CONFIG, type ApiConfig } from '../config';

export interface OutboxMail {
  to: string;
  subject: string;
  body: string;
  link?: string;
  sentAt: string;
}

const MAX = 50;

/**
 * Stand-in for real email delivery until BRD 23 (messaging). Mails are kept in memory and, outside
 * production, readable at `GET /dev/outbox`, the server-side twin of the storefront's `/dev/mailbox`.
 * Links are never logged in production (they grant access).
 */
@Injectable()
export class MailService {
  private readonly logger = new Logger('Mail');
  private readonly outbox: OutboxMail[] = [];

  constructor(@Inject(API_CONFIG) private readonly config: ApiConfig) {}

  send(mail: Omit<OutboxMail, 'sentAt'>): void {
    this.outbox.unshift({ ...mail, sentAt: new Date().toISOString() });
    this.outbox.length = Math.min(this.outbox.length, MAX);
    this.logger.log(JSON.stringify({ event: 'mail.queued', subject: mail.subject, ...(this.config.production ? {} : { to: mail.to, link: mail.link }) }));
  }

  list(): OutboxMail[] {
    return [...this.outbox];
  }
}
