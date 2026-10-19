/**
 * Every source (WhatsApp, Telegram) turns its message into this shape before it
 * enters the pipeline. Nothing after ingestion knows where a message came from.
 */
export interface NormalizedMedia {
  mimeType: string;
  filename?: string;
  sizeBytes?: number;
  /** Downloads the file from the source. Called once, at ingestion. */
  download: () => Promise<Buffer>;
}

export interface NormalizedMessage {
  source: "whatsapp" | "telegram";
  groupExternalId: string;
  groupTitle?: string;
  /** Phone number (WhatsApp) or user id (Telegram) */
  sender: string;
  senderName?: string;
  text: string;
  media: NormalizedMedia[];
  sentAt: Date;
  replyToExternalId?: string;
  externalId: string;
}
