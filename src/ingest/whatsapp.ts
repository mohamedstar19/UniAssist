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
  proto,
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
  let qrCount = 0;
  let openedThisGen = false;
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
      // Send the QR to the admins on Telegram so the number can be linked from anywhere (a few times, not forever).
      if (++qrCount > 3) return;
      const png = await QRCode.toBuffer(qr, { width: 512 });
      await alertAdminsPhoto(png, "📱 واتساب محتاج ربط: افتح واتساب على الرقم المخصص ← الأجهزة المرتبطة ← اربط جهاز، وامسح الكود ده.");
      logger.info("WhatsApp QR sent to admins");
    }
    if (connection === "open") {
      openedThisGen = true;
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
      if (qrCount > 0 && !openedThisGen) {
        // The QR codes expired without being scanned: wait for the admin instead of spamming new ones.
        await alertAdmins("⌛ كود الـQR انتهى من غير ما يتمسح. لما تبقى جاهز ابعت /wareset ويوصلك كود جديد.");
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
    // "append" = messages that arrived while we were offline (restart, reconnect). Duplicates are
    // dropped by the unique (group, message id) constraint. Skip anything older than 3 days.
    if (type !== "notify" && type !== "append") return;
    const minTs = Date.now() / 1000 - 3 * 86400;
    for (const m of messages) {
      if (Number(m.messageTimestamp ?? 0) < minTs) continue;
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
  let type = getContentType(content);
  // An edited message: ingest the new text as a reply to the original, so the event gets updated.
  let editOf: string | null = null;
  if (type === "protocolMessage") {
    const pm = content.protocolMessage;
    if (pm?.type !== proto.Message.ProtocolMessage.Type.MESSAGE_EDIT || !pm.editedMessage || !pm.key?.id) return null;
    editOf = pm.key.id;
    content = pm.editedMessage;
    type = getContentType(content);
  }
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

  if (editOf) {
    media.length = 0; // files of the original were already stored
    text = `(تعديل على رسالة سابقة) ${text}`;
  }

  if (!groupTitles.has(jid)) await refreshGroups();
  const sender = await senderPhone(m);

  return {
    source: "whatsapp",
    groupExternalId: jid,
    groupTitle: groupTitles.get(jid),
    sender: sender.split("@")[0] ?? sender,
    senderName: m.pushName ?? undefined,
    text,
    media,
    sentAt: new Date(Number(m.messageTimestamp ?? Date.now() / 1000) * 1000),
    replyToExternalId: editOf ?? contextInfo?.stanzaId ?? undefined,
    externalId: editOf ? `${editOf}:edit:${m.messageTimestamp}` : (m.key.id ?? `${jid}-${m.messageTimestamp}`),
  };
}

/**
 * The sender's phone number. Newer groups address members by "LID" (a private id); the phone
 * number is then in participantAlt or the LID→PN mapping. Instructors are matched by phone.
 */
async function senderPhone(m: WAMessage): Promise<string> {
  const participant = m.key.participant ?? m.participant ?? "";
  const alt = m.key.participantAlt ?? "";
  let jid = participant;
  if (alt.endsWith("@s.whatsapp.net")) jid = alt;
  else if (participant.endsWith("@lid") && sock) {
    const pn = await sock.signalRepository.lidMapping.getPNForLID(participant).catch(() => null);
    if (pn) jid = pn;
  }
  const normalized = jidNormalizedUser(jid);
  return normalized.split("@")[0]?.split(":")[0] ?? normalized;
}
