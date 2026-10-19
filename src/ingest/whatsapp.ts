import { mkdir, rm } from "node:fs/promises";
import makeWASocket, {
  Browsers,
  DisconnectReason,
  downloadMediaMessage,
  fetchLatestBaileysVersion,
  getContentType,
  isJidGroup,
  jidNormalizedUser,
  makeCacheableSignalKeyStore,
  useMultiFileAuthState,
  type WAMessage,
  type WASocket,
} from "baileys";
import QRCode from "qrcode";
import { alertAdmins, alertAdminsPhoto } from "../admin/alerts.js";
import { config } from "../config.js";
import { logger } from "../lib/logger.js";
import type { NormalizedMedia, NormalizedMessage } from "../types.js";
import { ingestMessage } from "./store.js";

/**
 * WhatsApp reader (Baileys). HARD RULE: this socket only reads. It never sends
 * a message to any group or person — every outgoing message goes through Telegram.
 * Sending from an unofficial number is the fastest way to get it banned.
 */

const groupTitles = new Map<string, string>();
let sock: WASocket | null = null;
let connectedOnce = false;
let downAlertTimer: NodeJS.Timeout | null = null;
let downAlertSent = false;
/** Bumped on every (re)connect so events from an old socket are ignored. */
let generation = 0;

/** Unlinks the current number (admin command) so a new/backup number can be linked with a fresh QR. */
export async function resetWhatsApp(): Promise<void> {
  try {
    sock?.end(undefined);
  } catch {
    // already closed
  }
  sock = null;
  await rm(config.WHATSAPP_AUTH_DIR, { recursive: true, force: true });
  await startWhatsApp();
}

export async function startWhatsApp(): Promise<void> {
  const gen = ++generation;
  await mkdir(config.WHATSAPP_AUTH_DIR, { recursive: true });
  const { state, saveCreds } = await useMultiFileAuthState(config.WHATSAPP_AUTH_DIR);
  const { version } = await fetchLatestBaileysVersion().catch(() => ({ version: undefined }));
  const waLogger = logger.child({ mod: "baileys" });
  waLogger.level = "warn";

  sock = makeWASocket({
    version,
    auth: { creds: state.creds, keys: makeCacheableSignalKeyStore(state.keys, waLogger) },
    logger: waLogger,
    browser: Browsers.ubuntu("Chrome"),
    markOnlineOnConnect: false,
    syncFullHistory: false,
    shouldIgnoreJid: (jid) => !isJidGroup(jid),
  });

  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("connection.update", async (update) => {
    if (gen !== generation) return; // stale socket (replaced by a reset)
    const { connection, lastDisconnect, qr } = update;
    if (qr) {
      // Send the QR to the admins on Telegram so the number can be linked from anywhere.
      const png = await QRCode.toBuffer(qr, { width: 512 });
      await alertAdminsPhoto(png, "📱 واتساب محتاج ربط: افتح واتساب على الرقم المخصص ← الأجهزة المرتبطة ← اربط جهاز، وامسح الكود ده.");
      logger.info("WhatsApp QR sent to admins");
    }
    if (connection === "open") {
      logger.info("WhatsApp connected");
      if (downAlertTimer) clearTimeout(downAlertTimer);
      downAlertTimer = null;
      if (downAlertSent || !connectedOnce) await alertAdmins(connectedOnce ? "✅ رقم واتساب رجع اتصل." : "✅ رقم واتساب اتربط وبيقرأ الجروبات.");
      downAlertSent = false;
      connectedOnce = true;
      await refreshGroups();
    }
    if (connection === "close") {
      const code = (lastDisconnect?.error as { output?: { statusCode?: number } } | undefined)?.output?.statusCode;
      if (code === DisconnectReason.loggedOut || code === DisconnectReason.forbidden) {
        await alertAdmins(
          `🚨 رقم واتساب اتفصل نهائياً (code ${code}). غالباً اتقفل أو اتعمله logout.\n` +
            "اربط الرقم الاحتياطي: ابعت /wareset وامسح الـQR اللي هيوصلك من الموبايل اللي عليه الرقم الجديد.",
        );
        return;
      }
      logger.warn({ code }, "WhatsApp connection closed, reconnecting");
      // Short blips reconnect on their own; alert only if still down after a minute.
      if (!downAlertTimer && connectedOnce) {
        downAlertTimer = setTimeout(() => {
          downAlertTimer = null;
          downAlertSent = true;
          void alertAdmins(`⚠️ واتساب مفصول من أكتر من دقيقة (code ${code ?? "?"}). بحاول أرجّعه أوتوماتيك؛ لو ماتصلحش ابعت /wareset.`);
        }, 60_000);
      }
      setTimeout(() => gen === generation && startWhatsApp().catch((err) => logger.error({ err }, "WhatsApp restart failed")), 5000);
    }
  });

  sock.ev.on("messages.upsert", async ({ messages, type }) => {
    if (type !== "notify") return;
    for (const m of messages) {
      try {
        const norm = await normalize(m);
        if (norm) await ingestMessage(norm);
      } catch (err) {
        logger.error({ err }, "WhatsApp message ingest failed");
      }
    }
  });
}

async function refreshGroups(): Promise<void> {
  if (!sock) return;
  try {
    const groups = await sock.groupFetchAllParticipating();
    for (const g of Object.values(groups)) groupTitles.set(g.id, g.subject);
  } catch (err) {
    logger.warn({ err }, "could not fetch WhatsApp groups");
  }
}

async function normalize(m: WAMessage): Promise<NormalizedMessage | null> {
  const jid = m.key.remoteJid;
  if (!jid || !isJidGroup(jid) || !m.message || m.key.fromMe) return null;

  // Unwrap ephemeral / view-once / document-with-caption wrappers.
  let content = m.message;
  for (let i = 0; i < 3; i++) {
    const inner =
      content.ephemeralMessage?.message ??
      content.viewOnceMessage?.message ??
      content.viewOnceMessageV2?.message ??
      content.documentWithCaptionMessage?.message;
    if (!inner) break;
    content = inner;
  }
  const type = getContentType(content);
  if (!type || type === "protocolMessage" || type === "reactionMessage") return null;

  let text = "";
  const media: NormalizedMedia[] = [];
  const dl = () => downloadMediaMessage(m, "buffer", {}) as Promise<Buffer>;
  let contextInfo: { stanzaId?: string | null } | null | undefined;

  switch (type) {
    case "conversation":
      text = content.conversation ?? "";
      break;
    case "extendedTextMessage":
      text = content.extendedTextMessage?.text ?? "";
      contextInfo = content.extendedTextMessage?.contextInfo;
      break;
    case "imageMessage":
      text = content.imageMessage?.caption ?? "";
      contextInfo = content.imageMessage?.contextInfo;
      media.push({ mimeType: content.imageMessage?.mimetype ?? "image/jpeg", sizeBytes: Number(content.imageMessage?.fileLength ?? 0), download: dl });
      break;
    case "documentMessage":
      text = content.documentMessage?.caption ?? "";
      contextInfo = content.documentMessage?.contextInfo;
      media.push({
        mimeType: content.documentMessage?.mimetype ?? "application/octet-stream",
        filename: content.documentMessage?.fileName ?? undefined,
        sizeBytes: Number(content.documentMessage?.fileLength ?? 0),
        download: dl,
      });
      break;
    default:
      return null; // stickers, audio, video, polls: ignored in the MVP
  }

  if (!groupTitles.has(jid)) await refreshGroups();
  const sender = jidNormalizedUser(m.key.participant ?? m.participant ?? "");

  return {
    source: "whatsapp",
    groupExternalId: jid,
    groupTitle: groupTitles.get(jid),
    sender: sender.split("@")[0] ?? sender,
    senderName: m.pushName ?? undefined,
    text,
    media,
    sentAt: new Date(Number(m.messageTimestamp ?? Date.now() / 1000) * 1000),
    replyToExternalId: contextInfo?.stanzaId ?? undefined,
    externalId: m.key.id ?? `${jid}-${m.messageTimestamp}`,
  };
}
