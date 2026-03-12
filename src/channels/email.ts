import fs from 'fs';
import path from 'path';

import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';
import * as nodemailer from 'nodemailer';
import type { Transporter } from 'nodemailer';

import { logger } from '../logger.js';
import { readEnvFile } from '../env.js';
import { STORE_DIR } from '../config.js';
import {
  Channel,
  OnInboundMessage,
  OnChatMetadata,
  NewMessage,
} from '../types.js';
import { registerChannel, ChannelOpts } from './registry.js';

// ---------------------------------------------------------------------------
// Config — read from process.env (set in .env)
// ---------------------------------------------------------------------------

interface EmailConfig {
  imap: {
    host: string;
    port: number;
    secure: boolean;
    user: string;
    pass: string;
  };
  smtp: {
    host: string;
    port: number;
    secure: boolean;
    user: string;
    pass: string;
  };
  fromAddress: string;
  fromName: string;
  allowFrom: string[]; // empty = allow all
  pollIntervalMs: number;
}

const EMAIL_ENV_KEYS = [
  'EMAIL_IMAP_HOST',
  'EMAIL_IMAP_PORT',
  'EMAIL_IMAP_SECURE',
  'EMAIL_IMAP_USER',
  'EMAIL_IMAP_PASS',
  'EMAIL_USER',
  'EMAIL_PASS',
  'EMAIL_SMTP_HOST',
  'EMAIL_SMTP_PORT',
  'EMAIL_SMTP_SECURE',
  'EMAIL_SMTP_USER',
  'EMAIL_SMTP_PASS',
  'EMAIL_FROM_ADDRESS',
  'EMAIL_FROM_NAME',
  'EMAIL_ALLOW_FROM',
  'EMAIL_POLL_INTERVAL',
];

function env(vars: Record<string, string>, key: string, fallback = ''): string {
  return vars[key] ?? process.env[key] ?? fallback;
}

function loadConfig(): EmailConfig | null {
  const vars = readEnvFile(EMAIL_ENV_KEYS);

  const user = env(vars, 'EMAIL_IMAP_USER') || env(vars, 'EMAIL_USER');
  const pass = env(vars, 'EMAIL_IMAP_PASS') || env(vars, 'EMAIL_PASS');
  const fromAddress = env(vars, 'EMAIL_FROM_ADDRESS') || user;

  if (!user || !pass || !fromAddress) return null;

  const allowFromRaw = env(vars, 'EMAIL_ALLOW_FROM');
  const allowFrom = allowFromRaw
    ? allowFromRaw
        .split(',')
        .map((s) => s.trim().toLowerCase())
        .filter(Boolean)
    : [];

  return {
    imap: {
      host: env(vars, 'EMAIL_IMAP_HOST', 'localhost'),
      port: parseInt(env(vars, 'EMAIL_IMAP_PORT', '1143'), 10),
      secure: env(vars, 'EMAIL_IMAP_SECURE', 'false') === 'true',
      user,
      pass,
    },
    smtp: {
      host: env(vars, 'EMAIL_SMTP_HOST', 'localhost'),
      port: parseInt(env(vars, 'EMAIL_SMTP_PORT', '1025'), 10),
      secure: env(vars, 'EMAIL_SMTP_SECURE', 'false') === 'true',
      user: env(vars, 'EMAIL_SMTP_USER') || user,
      pass: env(vars, 'EMAIL_SMTP_PASS') || pass,
    },
    fromAddress,
    fromName: env(vars, 'EMAIL_FROM_NAME'),
    allowFrom,
    pollIntervalMs: parseInt(env(vars, 'EMAIL_POLL_INTERVAL', '30000'), 10),
  };
}

// ---------------------------------------------------------------------------
// Utilities (adapted from openclaw-email-channel)
// ---------------------------------------------------------------------------

function extractEmail(addr: string): string {
  const match = addr.match(/<([^>]+)>/);
  return (match ? match[1] : addr).toLowerCase().trim();
}

function extractName(addr: string): string {
  const match = addr.match(/^([^<]+)</);
  if (match) return match[1].trim().replace(/^["']|["']$/g, '');
  return addr.split('@')[0];
}

function textToHtml(text: string): string {
  const escaped = text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
  const withLinks = escaped.replace(
    /(https?:\/\/[^\s<]+)/g,
    '<a href="$1">$1</a>',
  );
  const paragraphs = withLinks
    .split(/\n\n+/)
    .map((p) => p.trim())
    .filter(Boolean);
  if (paragraphs.length <= 1) {
    return `<div style="font-family:sans-serif;font-size:14px;line-height:1.5">${withLinks.replace(/\n/g, '<br>')}</div>`;
  }
  return `<div style="font-family:sans-serif;font-size:14px;line-height:1.5">${paragraphs.map((p) => `<p style="margin:0 0 1em 0">${p.replace(/\n/g, '<br>')}</p>`).join('\n')}</div>`;
}

function stripQuotedReplies(text: string): string {
  const lines = text.split('\n');
  const result: string[] = [];
  let foundContent = false;
  for (const line of lines) {
    if (line.trim().length > 0 && !line.match(/^>/)) foundContent = true;
    if (foundContent) {
      if (
        line.match(/^On .+ wrote:$/i) ||
        line.match(/^>/) ||
        line.match(/^-{5,}/) ||
        line.match(/^_{5,}/) ||
        line.match(/^From:.*<.*@.*>/) ||
        line.match(/^Sent from my/)
      )
        break;
    }
    if (!line.match(/^>/)) result.push(line);
  }
  const cleaned = result.join('\n').trim();
  return (
    cleaned ||
    text
      .split('\n')
      .filter((l) => !l.match(/^>/))
      .join('\n')
      .trim()
  );
}

function matchesAllowlist(email: string, allowlist: string[]): boolean {
  if (allowlist.length === 0) return true;
  const norm = email.toLowerCase().trim();
  for (const entry of allowlist) {
    const p = entry.toLowerCase().trim();
    if (p === '*' || p === norm) return true;
    if (p.startsWith('@') && norm.endsWith(p)) return true;
    if (norm.includes(p)) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// SMTP pool
// ---------------------------------------------------------------------------

interface PooledTransport {
  transport: Transporter;
  lastUsed: number;
  inUse: boolean;
}
const smtpPool = new Map<string, PooledTransport>();
setInterval(() => {
  const now = Date.now();
  for (const [key, pooled] of smtpPool) {
    if (!pooled.inUse && now - pooled.lastUsed > 5 * 60 * 1000) {
      pooled.transport.close();
      smtpPool.delete(key);
    }
  }
}, 60_000);

function smtpKey(cfg: EmailConfig['smtp']): string {
  return `${cfg.host}:${cfg.port}:${cfg.user}`;
}

async function getSmtpTransport(
  cfg: EmailConfig['smtp'],
): Promise<Transporter> {
  const key = smtpKey(cfg);
  let pooled = smtpPool.get(key);
  if (pooled && !pooled.inUse) {
    try {
      await pooled.transport.verify();
      pooled.inUse = true;
      pooled.lastUsed = Date.now();
      return pooled.transport;
    } catch {
      pooled.transport.close();
      smtpPool.delete(key);
    }
  }
  const transport = nodemailer.createTransport({
    host: cfg.host,
    port: cfg.port,
    secure: cfg.secure,
    auth: { user: cfg.user, pass: cfg.pass },
    pool: true,
    maxConnections: 3,
    maxMessages: 100,
  });
  smtpPool.set(key, { transport, lastUsed: Date.now(), inUse: true });
  return transport;
}

function releaseSmtpTransport(cfg: EmailConfig['smtp']): void {
  const pooled = smtpPool.get(smtpKey(cfg));
  if (pooled) {
    pooled.inUse = false;
    pooled.lastUsed = Date.now();
  }
}

// ---------------------------------------------------------------------------
// Thread tracking (subject + last message-id per conversation)
// ---------------------------------------------------------------------------

const conversations = new Map<
  string,
  { subject: string; lastMessageId: string }
>();

function threadKey(fromAddr: string, toAddr: string): string {
  return [extractEmail(fromAddr), extractEmail(toAddr)].sort().join(':');
}

// ---------------------------------------------------------------------------
// Inbox snapshot (written to store/email-inbox.json after each poll)
// ---------------------------------------------------------------------------

interface InboxEntry {
  id: string;
  from: string;
  from_name: string;
  subject: string;
  body: string;
  timestamp: string;
}

const INBOX_SNAPSHOT_PATH = path.join(STORE_DIR, 'email-inbox.json');
const LAST_UID_PATH = path.join(STORE_DIR, 'email-last-uid.json');
const MAX_INBOX_SNAPSHOT = 20;
const inboxSnapshot: InboxEntry[] = [];

function loadLastUid(): number {
  try {
    if (fs.existsSync(LAST_UID_PATH)) {
      return JSON.parse(fs.readFileSync(LAST_UID_PATH, 'utf-8')).uid ?? 0;
    }
  } catch {}
  return 0;
}

function saveLastUid(uid: number): void {
  try {
    fs.mkdirSync(STORE_DIR, { recursive: true });
    fs.writeFileSync(LAST_UID_PATH, JSON.stringify({ uid }));
  } catch (err) {
    logger.warn({ err }, '[email] Failed to save last UID');
  }
}

function writeInboxSnapshot(): void {
  try {
    fs.mkdirSync(STORE_DIR, { recursive: true });
    const tmp = `${INBOX_SNAPSHOT_PATH}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(inboxSnapshot, null, 2));
    fs.renameSync(tmp, INBOX_SNAPSHOT_PATH);
  } catch (err) {
    logger.warn({ err }, '[email] Failed to write inbox snapshot');
  }
}

// ---------------------------------------------------------------------------
// EmailChannel
// ---------------------------------------------------------------------------

export class EmailChannel implements Channel {
  name = 'email';

  private cfg: EmailConfig;
  private opts: ChannelOpts;
  private onMessage: OnInboundMessage;
  private onChatMetadata: OnChatMetadata;
  private imapClient: ImapFlow | null = null;
  private pollTimer: NodeJS.Timeout | null = null;
  private stopped = false;
  private connected = false;
  // Highest UID we have processed — persisted to disk so restarts don't re-process old mail
  private lastProcessedUid = 0;

  constructor(cfg: EmailConfig, opts: ChannelOpts) {
    this.cfg = cfg;
    this.opts = opts;
    this.onMessage = opts.onMessage;
    this.onChatMetadata = opts.onChatMetadata;
    this.lastProcessedUid = loadLastUid();
  }

  /** JID for an email conversation: "email:<address>" */
  private jid(addr: string): string {
    return `email:${extractEmail(addr)}`;
  }

  ownsJid(jid: string): boolean {
    return jid.startsWith('email:');
  }

  isConnected(): boolean {
    return this.connected;
  }

  async connect(): Promise<void> {
    this.stopped = false;
    this.imapClient = await this.createImap();
    if (!this.imapClient) {
      logger.warn(
        '[email] IMAP connection failed at startup — will retry on next poll',
      );
    } else {
      this.connected = true;
    }
    // Auto-register allowed senders as groups so incoming emails trigger the agent.
    // Each sender gets their own group (requiresTrigger: false — all emails respond).
    if (this.opts.registerGroup && this.cfg.allowFrom.length > 0) {
      const existing = this.opts.registeredGroups();
      for (const addr of this.cfg.allowFrom) {
        if (addr === '*') continue; // wildcard — skip, can't create a group for *
        const jid = `email:${addr}`;
        if (existing[jid]) continue; // already registered
        // Folder: email_ + sanitised address (replace non-alphanumeric with -)
        const safeName = addr
          .replace(/[^a-zA-Z0-9]/g, '-')
          .replace(/-+/g, '-')
          .replace(/^-|-$/g, '')
          .slice(0, 55);
        const folder = `email_${safeName}`;
        const group = {
          name: addr,
          folder,
          trigger: '',
          added_at: new Date().toISOString(),
          requiresTrigger: false,
        };
        this.opts.registerGroup(jid, group);
        logger.info(
          `[email] Auto-registered group for ${addr} (folder: ${folder})`,
        );
      }
    }

    // Fire-and-forget: don't block startup waiting for the initial IMAP mailbox lock
    // (hydroxide can be slow to sync INBOX, which would delay WhatsApp from connecting)
    // Populate snapshot from existing mail first, then check for unseen
    this.populateInitialSnapshot()
      .then(() => this.checkEmails())
      .catch((err) => logger.error({ err }, '[email] Initial setup failed'));
    this.pollTimer = setInterval(
      () => this.checkEmails(),
      this.cfg.pollIntervalMs,
    );
    logger.info(`[email] Polling every ${this.cfg.pollIntervalMs}ms`);
  }

  async disconnect(): Promise<void> {
    this.stopped = true;
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    if (this.imapClient) {
      try {
        await this.imapClient.logout();
      } catch {}
      this.imapClient = null;
    }
    this.connected = false;
  }

  async syncInbox(): Promise<void> {
    await this.checkEmails();
  }

  async sendEmail(to: string, subject: string, body: string): Promise<void> {
    const transport = await getSmtpTransport(this.cfg.smtp);
    try {
      const from = this.cfg.fromName
        ? `"${this.cfg.fromName}" <${this.cfg.fromAddress}>`
        : this.cfg.fromAddress;
      await transport.sendMail({ from, to, subject, text: body, html: textToHtml(body) });
      logger.info(`[email] Sent email to ${to}: ${subject}`);
    } finally {
      releaseSmtpTransport(this.cfg.smtp);
    }
  }

  async sendMessage(jid: string, text: string): Promise<void> {
    // jid format: "email:<address>"
    const toAddr = jid.replace(/^email:/, '');
    const key = threadKey(toAddr, this.cfg.fromAddress);
    const conv = conversations.get(key);
    const rawSubject = conv?.subject ?? 'Message';
    const subject = rawSubject.startsWith('Re:')
      ? rawSubject
      : `Re: ${rawSubject}`;

    const transport = await getSmtpTransport(this.cfg.smtp);
    try {
      const from = this.cfg.fromName
        ? `"${this.cfg.fromName}" <${this.cfg.fromAddress}>`
        : this.cfg.fromAddress;
      await transport.sendMail({
        from,
        to: toAddr,
        subject,
        text,
        html: textToHtml(text),
        ...(conv?.lastMessageId
          ? { inReplyTo: conv.lastMessageId, references: conv.lastMessageId }
          : {}),
      });
      logger.info(`[email] Sent reply to ${toAddr}`);
    } finally {
      releaseSmtpTransport(this.cfg.smtp);
    }
  }

  // ---- private ----

  private async populateInitialSnapshot(): Promise<void> {
    if (!this.imapClient) return;
    try {
      const lock = await this.imapClient.getMailboxLock('INBOX');
      try {
        const searchResult = await this.imapClient.search({ all: true });
        const allUids: number[] = Array.isArray(searchResult)
          ? (searchResult as number[])
          : [];
        // Take the last MAX_INBOX_SNAPSHOT UIDs (most recent)
        const recent = allUids.slice(-MAX_INBOX_SNAPSHOT).reverse();
        for (const uid of recent) {
          const entry = await this.parseEmailEntry(uid);
          if (entry) inboxSnapshot.push(entry);
        }
        if (inboxSnapshot.length > 0) writeInboxSnapshot();
        logger.info(
          `[email] Inbox snapshot populated with ${inboxSnapshot.length} emails`,
        );
      } finally {
        lock.release();
      }
    } catch (err) {
      logger.warn({ err }, '[email] Failed to populate initial inbox snapshot');
    }
  }

  private async parseEmailEntry(uid: number): Promise<InboxEntry | null> {
    if (!this.imapClient) return null;
    try {
      const msg = (await this.imapClient.fetchOne(uid, {
        source: true,
      })) as any;
      if (!msg?.source) return null;
      const parsed = await simpleParser(msg.source as Buffer);
      const fromAddr = extractEmail(parsed.from?.value?.[0]?.address ?? '');
      if (!fromAddr) return null;
      const fromName = parsed.from?.value?.[0]?.name || extractName(fromAddr);
      return {
        id: parsed.messageId || `${uid}@local`,
        from: fromAddr,
        from_name: fromName || fromAddr,
        subject: parsed.subject || '(no subject)',
        body: stripQuotedReplies(
          parsed.text ||
            (parsed.html
              ? parsed.html
                  .replace(/<[^>]+>/g, ' ')
                  .replace(/\s+/g, ' ')
                  .trim()
              : ''),
        ),
        timestamp: (parsed.date ?? new Date()).toISOString(),
      };
    } catch {
      return null;
    }
  }

  private async createImap(): Promise<ImapFlow | null> {
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const client = new ImapFlow({
          host: this.cfg.imap.host,
          port: this.cfg.imap.port,
          secure: this.cfg.imap.secure,
          auth: { user: this.cfg.imap.user, pass: this.cfg.imap.pass },
          logger: false,
          socketTimeout: 300000, // 5 min — gives hydroxide time to finish INBOX sync
        });
        client.on('error', (err: Error) => {
          logger.warn({ err }, '[email] IMAP socket error');
        });
        await client.connect();
        logger.info(
          `[email] IMAP connected to ${this.cfg.imap.host}:${this.cfg.imap.port}`,
        );
        return client;
      } catch (err: any) {
        if (
          err.authenticationFailed ||
          err.serverResponseCode === 'AUTHENTICATIONFAILED'
        ) {
          logger.error(
            '[email] IMAP authentication failed — check EMAIL_IMAP_PASS',
          );
          return null;
        }
        logger.warn(
          `[email] IMAP connect attempt ${attempt}/3: ${err.message}`,
        );
        if (attempt < 3)
          await new Promise((r) => setTimeout(r, 2000 * attempt));
      }
    }
    return null;
  }

  private async checkEmails(): Promise<void> {
    if (this.stopped) return;

    // Reconnect if needed
    if (!this.imapClient) {
      this.imapClient = await this.createImap();
      if (!this.imapClient) return;
      this.connected = true;
    }

    try {
      const lock = await this.imapClient.getMailboxLock('INBOX');
      try {
        const allResult = await this.imapClient.search({ all: true });
        const allUids: number[] = Array.isArray(allResult)
          ? (allResult as number[])
          : [];

        // On first run, seed the cursor to the current max UID to skip existing mail
        if (this.lastProcessedUid === 0 && allUids.length > 0) {
          this.lastProcessedUid = Math.max(...allUids);
          saveLastUid(this.lastProcessedUid);
          logger.info(
            `[email] Seeded UID cursor to ${this.lastProcessedUid} (${allUids.length} existing messages skipped)`,
          );
        }

        const newUids = allUids.filter((uid) => uid > this.lastProcessedUid);
        logger.info(
          `[email] Poll: ${newUids.length} new message(s) since UID ${this.lastProcessedUid}`,
        );
        for (const uid of newUids) {
          await this.processMessage(uid);
          if (uid > this.lastProcessedUid) {
            this.lastProcessedUid = uid;
            saveLastUid(uid);
          }
        }
      } finally {
        lock.release();
      }
    } catch (err: any) {
      logger.error({ err }, '[email] Error checking inbox');
      const msg = (err.message ?? '').toLowerCase();
      if (
        msg.includes('connect') ||
        msg.includes('socket') ||
        msg.includes('econnreset') ||
        msg.includes('not available')
      ) {
        logger.info('[email] IMAP reconnecting...');
        try {
          await this.imapClient.logout();
        } catch {}
        this.imapClient = null;
        this.connected = false;
      }
    }
  }

  private async processMessage(uid: number): Promise<void> {
    if (!this.imapClient) return;
    try {
      // fetchOne returns FetchMessageObject or false if not found
      const msg = (await this.imapClient.fetchOne(uid, {
        source: true,
      })) as any;
      if (!msg || !msg.source) return;

      const parsed = await simpleParser(msg.source as Buffer);
      const fromAddr = extractEmail(parsed.from?.value?.[0]?.address ?? '');
      const fromName = parsed.from?.value?.[0]?.name || extractName(fromAddr);

      // Only process emails actually addressed to Andy's address
      const toAddrs =
        (parsed.to as any)?.value?.map((a: any) =>
          extractEmail(a.address ?? ''),
        ) ?? [];
      logger.info(
        `[email] UID ${uid}: from=${fromAddr} to=${JSON.stringify(toAddrs)} subject="${parsed.subject}"`,
      );
      if (!toAddrs.includes(this.cfg.fromAddress.toLowerCase())) {
        logger.info(
          `[email] Skipping UID ${uid} (to=${JSON.stringify(toAddrs)}, expected ${this.cfg.fromAddress})`,
        );
        return;
      }

      if (!matchesAllowlist(fromAddr, this.cfg.allowFrom)) {
        logger.info(
          `[email] Skipping UID ${uid} from ${fromAddr} (not in allowlist)`,
        );
        return;
      }

      const messageId = parsed.messageId || `${Date.now()}@local`;
      const subject = parsed.subject || '(no subject)';
      // Fall back to HTML-stripped text if plain text part is missing (e.g. ProtonMail webmail)
      const rawText =
        parsed.text ||
        (parsed.html
          ? parsed.html
              .replace(/<[^>]+>/g, ' ')
              .replace(/\s+/g, ' ')
              .trim()
          : '');
      const text = stripQuotedReplies(rawText);

      const key = threadKey(fromAddr, this.cfg.fromAddress);
      conversations.set(key, { subject, lastMessageId: messageId });

      // Add to inbox snapshot (prepend so newest is first, cap at MAX)
      inboxSnapshot.unshift({
        id: messageId,
        from: fromAddr,
        from_name: fromName || fromAddr,
        subject,
        body: text,
        timestamp: (parsed.date ?? new Date()).toISOString(),
      });
      if (inboxSnapshot.length > MAX_INBOX_SNAPSHOT)
        inboxSnapshot.length = MAX_INBOX_SNAPSHOT;
      writeInboxSnapshot();

      const chatJid = this.jid(fromAddr);
      const timestamp = (parsed.date ?? new Date()).toISOString();

      this.onChatMetadata(
        chatJid,
        timestamp,
        fromName || fromAddr,
        'email',
        false,
      );

      const inboundMsg: NewMessage = {
        id: messageId,
        chat_jid: chatJid,
        sender: fromAddr,
        sender_name: fromName || fromAddr,
        content: `[Email — Subject: ${subject}]\n\n${text}`,
        timestamp,
        is_from_me: false,
        is_bot_message: false,
      };

      this.onMessage(chatJid, inboundMsg);
      logger.info(`[email] Received email from ${fromAddr}: ${subject}`);

      await this.imapClient.messageFlagsAdd(uid, ['\\Seen']);
    } catch (err: any) {
      const msg = (err.message ?? '').toLowerCase();
      if (
        msg.includes('connect') ||
        msg.includes('not available') ||
        msg.includes('econnreset')
      ) {
        throw err; // let checkEmails handle reconnect
      }
      logger.error({ err }, `[email] Error processing message uid=${uid}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Self-registration
// ---------------------------------------------------------------------------

registerChannel('email', (opts) => {
  const cfg = loadConfig();
  if (!cfg) {
    logger.info(
      '[email] Channel not configured — set EMAIL_IMAP_USER, EMAIL_IMAP_PASS, EMAIL_FROM_ADDRESS',
    );
    return null;
  }
  return new EmailChannel(cfg, opts);
});
