/**
 * One-off script to accept a WhatsApp group invite link.
 * Usage: npx tsx scripts/join-group.ts <invite-code>
 */
import makeWASocket, {
  Browsers,
  fetchLatestWaWebVersion,
  makeCacheableSignalKeyStore,
  useMultiFileAuthState,
} from '@whiskeysockets/baileys';
import pino from 'pino';

const AUTH_DIR = './store/auth';
const inviteCode = process.argv[2];

if (!inviteCode) {
  console.error('Usage: npx tsx scripts/join-group.ts <invite-code>');
  process.exit(1);
}

const logger = pino({ level: 'warn' });

async function main() {
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);

  const { version } = await fetchLatestWaWebVersion({}).catch(() => ({
    version: undefined,
  }));

  const sock = makeWASocket({
    version,
    auth: {
      creds: state.creds,
      keys: makeCacheableSignalKeyStore(state.keys, logger),
    },
    printQRInTerminal: false,
    logger,
    browser: Browsers.macOS('Chrome'),
  });

  sock.ev.on('creds.update', saveCreds);

  await new Promise<void>((resolve, reject) => {
    sock.ev.on('connection.update', async ({ connection, lastDisconnect }) => {
      if (connection === 'open') {
        try {
          console.log(`Accepting invite code: ${inviteCode}`);
          const groupId = await sock.groupAcceptInvite(inviteCode);
          console.log(`✓ Joined group! JID: ${groupId}`);
        } catch (err: any) {
          console.error('✗ Failed to join group:', err.message);
        }
        await sock.logout().catch(() => {});
        resolve();
      } else if (connection === 'close') {
        resolve();
      }
    });
  });

  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
