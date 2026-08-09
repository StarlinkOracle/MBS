import { S3Client, PutObjectCommand, GetObjectCommand } from "@aws-sdk/client-s3";
import crypto from "crypto";
import path from "path";
import fs from "fs";

export interface AttachmentMetadata {
  provider: "S3" | "LOCAL";
  bucket: string | null;
  objectKey: string;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  checksumSha256: string;
  url: string | null;
}

const uploadsDir = path.join(process.cwd(), "uploads");
if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true });
}

export function isS3Configured(): boolean {
  return !!(
    process.env.S3_ENDPOINT &&
    process.env.S3_ACCESS_KEY &&
    process.env.S3_SECRET_KEY &&
    process.env.S3_BUCKET
  );
}

function getS3Client(): S3Client {
  return new S3Client({
    endpoint: process.env.S3_ENDPOINT!,
    region: process.env.S3_REGION || "us-east-1",
    credentials: {
      accessKeyId: process.env.S3_ACCESS_KEY!,
      secretAccessKey: process.env.S3_SECRET_KEY!,
    },
    forcePathStyle: true,
  });
}

function sanitizeFilename(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]/g, "_").substring(0, 100);
}

function buildObjectKey(originalName: string): string {
  const now = new Date();
  const yyyy = now.getFullYear();
  const mm = String(now.getMonth() + 1).padStart(2, "0");
  const dd = String(now.getDate()).padStart(2, "0");
  const ts = Date.now();
  const rand = Math.random().toString(36).substring(2, 8);
  const safe = sanitizeFilename(originalName);
  return `price-match/${yyyy}/${mm}/${dd}/${ts}_${rand}_${safe}`;
}

function computeSha256(buffer: Buffer): string {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

export async function getS3Stream(objectKey: string): Promise<{ stream: NodeJS.ReadableStream; contentType: string } | null> {
  if (!isS3Configured()) return null;
  try {
    const client = getS3Client();
    const bucket = process.env.S3_BUCKET!;
    const response = await client.send(
      new GetObjectCommand({ Bucket: bucket, Key: objectKey })
    );
    if (!response.Body) return null;
    return {
      stream: response.Body as unknown as NodeJS.ReadableStream,
      contentType: response.ContentType || "application/octet-stream",
    };
  } catch (err) {
    console.error("S3 get object failed:", err);
    return null;
  }
}

export async function uploadFile(
  buffer: Buffer,
  originalName: string,
  mimeType: string
): Promise<AttachmentMetadata> {
  const checksum = computeSha256(buffer);
  const objectKey = buildObjectKey(originalName);

  if (isS3Configured()) {
    const client = getS3Client();
    const bucket = process.env.S3_BUCKET!;

    try {
      await client.send(
        new PutObjectCommand({
          Bucket: bucket,
          Key: objectKey,
          Body: buffer,
          ContentType: mimeType,
        })
      );

      const publicUrl = process.env.S3_PUBLIC_BASE_URL
        ? `${process.env.S3_PUBLIC_BASE_URL}/${objectKey}`
        : null;

      return {
        provider: "S3",
        bucket,
        objectKey,
        fileName: originalName,
        mimeType,
        sizeBytes: buffer.length,
        checksumSha256: checksum,
        url: publicUrl,
      };
    } catch (err) {
      console.error("S3 upload failed, falling back to local disk:", err);
    }
  }

  const localFilename = `${Date.now()}_${Math.round(Math.random() * 1e9)}${path.extname(originalName)}`;
  const localPath = path.join(uploadsDir, localFilename);
  fs.writeFileSync(localPath, buffer);

  return {
    provider: "LOCAL",
    bucket: null,
    objectKey: localFilename,
    fileName: originalName,
    mimeType,
    sizeBytes: buffer.length,
    checksumSha256: checksum,
    url: null,
  };
}
