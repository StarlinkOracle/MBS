import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import {
  CreateBucketCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  PutObjectCommand,
  type PutObjectCommandInput,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl as signS3Request } from '@aws-sdk/s3-request-presigner';

type PrimitiveBody = Buffer | Uint8Array | string;

export type StorageConfig = {
  endpoint: string;
  accessKeyId: string;
  secretAccessKey: string;
  bucket: string;
  region: string;
  forcePathStyle: boolean;
};

export type PutObjectParams = {
  objectKey: string;
  body: PutObjectCommandInput['Body'];
  bucket?: string;
  contentType?: string;
  metadata?: Record<string, string>;
  checksumSha256?: string;
};

export type PutObjectResult = {
  bucket: string;
  objectKey: string;
  etag?: string;
  checksumSha256?: string;
};

export type SignedUrlParams = {
  objectKey: string;
  bucket?: string;
  expiresSeconds?: number;
};

export type DeleteObjectParams = {
  objectKey: string;
  bucket?: string;
};

export type GetObjectParams = {
  objectKey: string;
  bucket?: string;
};

export type GetObjectResult = {
  bucket: string;
  objectKey: string;
  body: Readable;
  contentType?: string;
  contentLength?: number;
  etag?: string;
};

let cachedClient: S3Client | null = null;
let cachedConfigKey = '';
const ensuredBuckets = new Set<string>();

const normalizeEndpoint = (raw: string) => raw.replace(/\/+$/, '');

export const resolveStorageConfig = (
  overrides: Partial<StorageConfig> = {},
): StorageConfig => {
  const endpoint = normalizeEndpoint(
    overrides.endpoint ?? process.env.S3_ENDPOINT ?? 'http://localhost:9000',
  );
  const accessKeyId = overrides.accessKeyId ?? process.env.S3_ACCESS_KEY ?? '';
  const secretAccessKey =
    overrides.secretAccessKey ?? process.env.S3_SECRET_KEY ?? '';
  const bucket = overrides.bucket ?? process.env.S3_BUCKET ?? '';
  const region = overrides.region ?? process.env.S3_REGION ?? 'us-east-1';
  const forcePathStyle =
    overrides.forcePathStyle ??
    String(process.env.S3_FORCE_PATH_STYLE ?? 'true').toLowerCase() !== 'false';

  if (!accessKeyId) {
    throw new Error('S3_ACCESS_KEY is required');
  }
  if (!secretAccessKey) {
    throw new Error('S3_SECRET_KEY is required');
  }
  if (!bucket) {
    throw new Error('S3_BUCKET is required');
  }

  return {
    endpoint,
    accessKeyId,
    secretAccessKey,
    bucket,
    region,
    forcePathStyle,
  };
};

export const getStorageClient = (
  overrides: Partial<StorageConfig> = {},
): S3Client => {
  const config = resolveStorageConfig(overrides);
  const nextKey = JSON.stringify(config);

  if (!cachedClient || cachedConfigKey !== nextKey) {
    cachedClient = new S3Client({
      region: config.region,
      endpoint: config.endpoint,
      forcePathStyle: config.forcePathStyle,
      credentials: {
        accessKeyId: config.accessKeyId,
        secretAccessKey: config.secretAccessKey,
      },
    });
    cachedConfigKey = nextKey;
    ensuredBuckets.clear();
  }

  return cachedClient;
};

const isPrimitiveBody = (value: unknown): value is PrimitiveBody =>
  typeof value === 'string' || value instanceof Uint8Array;

export const computeChecksum = async (
  value: PrimitiveBody | NodeJS.ReadableStream,
): Promise<string> => {
  const hash = createHash('sha256');

  if (isPrimitiveBody(value)) {
    hash.update(value);
    return hash.digest('hex');
  }

  for await (const chunk of value as Readable) {
    if (typeof chunk === 'string') {
      hash.update(chunk);
    } else if (chunk instanceof Uint8Array) {
      hash.update(chunk);
    } else {
      hash.update(Buffer.from(chunk));
    }
  }

  return hash.digest('hex');
};

const ensureBucket = async (
  client: S3Client,
  bucket: string,
): Promise<void> => {
  if (ensuredBuckets.has(bucket)) {
    return;
  }

  try {
    await client.send(new HeadBucketCommand({ Bucket: bucket }));
    ensuredBuckets.add(bucket);
    return;
  } catch {
    await client.send(new CreateBucketCommand({ Bucket: bucket }));
    ensuredBuckets.add(bucket);
  }
};

const stripEtagQuotes = (etag?: string): string | undefined => {
  if (!etag) {
    return undefined;
  }
  return etag.replace(/^\"|\"$/g, '');
};

export const putObject = async (
  params: PutObjectParams,
  overrides: Partial<StorageConfig> = {},
): Promise<PutObjectResult> => {
  const config = resolveStorageConfig(overrides);
  const client = getStorageClient(config);
  const bucket = params.bucket ?? config.bucket;

  await ensureBucket(client, bucket);

  const checksumSha256 =
    params.checksumSha256 ??
    (isPrimitiveBody(params.body) ? await computeChecksum(params.body) : undefined);

  const response = await client.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: params.objectKey,
      Body: params.body,
      ContentType: params.contentType,
      Metadata: params.metadata,
    }),
  );

  return {
    bucket,
    objectKey: params.objectKey,
    etag: stripEtagQuotes(response.ETag),
    checksumSha256,
  };
};

export const getSignedUrl = async (
  params: SignedUrlParams,
  overrides: Partial<StorageConfig> = {},
): Promise<string> => {
  const config = resolveStorageConfig(overrides);
  const client = getStorageClient(config);
  const bucket = params.bucket ?? config.bucket;

  return signS3Request(
    client,
    new GetObjectCommand({
      Bucket: bucket,
      Key: params.objectKey,
    }),
    {
      expiresIn: params.expiresSeconds ?? 900,
    },
  );
};

export const deleteObject = async (
  params: DeleteObjectParams,
  overrides: Partial<StorageConfig> = {},
): Promise<void> => {
  const config = resolveStorageConfig(overrides);
  const client = getStorageClient(config);
  const bucket = params.bucket ?? config.bucket;

  await client.send(
    new DeleteObjectCommand({
      Bucket: bucket,
      Key: params.objectKey,
    }),
  );
};

const toReadableBody = async (body: unknown): Promise<Readable> => {
  if (body instanceof Readable) {
    return body;
  }

  if (body instanceof Uint8Array) {
    return Readable.from(body);
  }

  if (typeof body === 'string') {
    return Readable.from(body);
  }

  const bodyRecord =
    typeof body === 'object' && body !== null
      ? (body as Record<string, unknown>)
      : null;

  const transformToByteArray = bodyRecord?.transformToByteArray;
  if (typeof transformToByteArray === 'function') {
    const bytes = await transformToByteArray.call(body);
    return Readable.from(bytes as Uint8Array);
  }

  const transformToWebStream = bodyRecord?.transformToWebStream;
  if (typeof transformToWebStream === 'function') {
    const webStream = transformToWebStream.call(body) as unknown;
    const webRecord =
      typeof webStream === 'object' && webStream !== null
        ? (webStream as Record<string, unknown>)
        : null;
    const getReader = webRecord?.getReader;
    if (typeof getReader === 'function') {
      const reader = getReader.call(webStream) as {
        read: () => Promise<{ done: boolean; value?: Uint8Array }>;
        releaseLock?: () => void;
      };

      const iterator = async function* (): AsyncGenerator<Uint8Array> {
        try {
          while (true) {
            const chunk = await reader.read();
            if (chunk.done) {
              break;
            }
            if (chunk.value) {
              yield chunk.value;
            }
          }
        } finally {
          if (typeof reader.releaseLock === 'function') {
            reader.releaseLock();
          }
        }
      };

      return Readable.from(iterator());
    }
  }

  throw new Error('Unsupported object body stream type from storage provider');
};

export const getObject = async (
  params: GetObjectParams,
  overrides: Partial<StorageConfig> = {},
): Promise<GetObjectResult> => {
  const config = resolveStorageConfig(overrides);
  const client = getStorageClient(config);
  const bucket = params.bucket ?? config.bucket;

  const response = await client.send(
    new GetObjectCommand({
      Bucket: bucket,
      Key: params.objectKey,
    }),
  );

  if (!response.Body) {
    throw new Error('Object body is empty');
  }

  return {
    bucket,
    objectKey: params.objectKey,
    body: await toReadableBody(response.Body),
    contentType: response.ContentType,
    contentLength: typeof response.ContentLength === 'number' ? response.ContentLength : undefined,
    etag: stripEtagQuotes(response.ETag),
  };
};
