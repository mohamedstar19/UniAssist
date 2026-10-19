import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { config } from "../config.js";

/** File storage: Cloudflare R2 / S3 when configured, local disk otherwise. */
const s3 = config.S3_BUCKET
  ? new S3Client({
      region: config.S3_REGION,
      endpoint: config.S3_ENDPOINT,
      credentials:
        config.S3_ACCESS_KEY_ID && config.S3_SECRET_ACCESS_KEY
          ? { accessKeyId: config.S3_ACCESS_KEY_ID, secretAccessKey: config.S3_SECRET_ACCESS_KEY }
          : undefined,
    })
  : null;

function localPath(key: string): string {
  const safe = key.replace(/\.\./g, "_");
  return path.resolve(config.STORAGE_DIR, safe);
}

export async function putFile(key: string, data: Buffer, mimeType: string): Promise<void> {
  if (s3) {
    await s3.send(new PutObjectCommand({ Bucket: config.S3_BUCKET, Key: key, Body: data, ContentType: mimeType }));
    return;
  }
  const p = localPath(key);
  await mkdir(path.dirname(p), { recursive: true });
  await writeFile(p, data);
}

export async function getFile(key: string): Promise<Buffer> {
  if (s3) {
    const res = await s3.send(new GetObjectCommand({ Bucket: config.S3_BUCKET, Key: key }));
    const bytes = await res.Body!.transformToByteArray();
    return Buffer.from(bytes);
  }
  return readFile(localPath(key));
}
