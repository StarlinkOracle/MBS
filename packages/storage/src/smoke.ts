import { randomUUID } from 'node:crypto';
import { computeChecksum, getSignedUrl, putObject, resolveStorageConfig } from './index.js';

async function run() {
  const config = resolveStorageConfig();
  const payload = `storage-smoke ${new Date().toISOString()} ${randomUUID()}`;
  const objectKey = `smoke/${new Date().toISOString().slice(0, 10)}/${randomUUID()}.txt`;
  const checksumSha256 = await computeChecksum(payload);

  const uploaded = await putObject({
    objectKey,
    body: payload,
    contentType: 'text/plain',
    checksumSha256,
  });

  const signedUrl = await getSignedUrl({
    objectKey,
    expiresSeconds: 300,
  });

  console.log(
    JSON.stringify(
      {
        ok: true,
        endpoint: config.endpoint,
        bucket: uploaded.bucket,
        objectKey: uploaded.objectKey,
        etag: uploaded.etag,
        checksumSha256: uploaded.checksumSha256,
        signedUrlPreview: `${signedUrl.slice(0, 96)}...`,
      },
      null,
      2,
    ),
  );
}

run().catch((error) => {
  console.error('storage-smoke-failed', error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
