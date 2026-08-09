import { randomUUID } from 'node:crypto';

import {
  beforeAll,
  afterEach,
  describe,
  expect,
  it,
} from 'vitest';
import supertest from 'supertest';

const describeIfDb = process.env.DATABASE_URL ? describe : describe.skip;

describeIfDb('public quote media visibility', () => {
  let request: ReturnType<typeof supertest>;
  let prisma: any;
  const createdOrgIds: string[] = [];

  beforeAll(async () => {
    process.env.DATABASE_URL =
      process.env.DATABASE_URL ??
      'postgresql://postgres:postgres@localhost:5432/rcs?schema=public';
    process.env.S3_ENDPOINT = process.env.S3_ENDPOINT ?? 'http://localhost:9000';
    process.env.S3_REGION = process.env.S3_REGION ?? 'us-east-1';
    process.env.S3_ACCESS_KEY = process.env.S3_ACCESS_KEY ?? 'minioadmin';
    process.env.S3_SECRET_KEY = process.env.S3_SECRET_KEY ?? 'minioadmin';
    process.env.S3_BUCKET = process.env.S3_BUCKET ?? 'mbs';
    process.env.S3_FORCE_PATH_STYLE = process.env.S3_FORCE_PATH_STYLE ?? 'true';

    const [{ app }, db] = await Promise.all([
      import('../src/index.js'),
      import('@rcs/db'),
    ]);
    request = supertest(app);
    prisma = db.prisma;
  });

  afterEach(async () => {
    while (createdOrgIds.length > 0) {
      const orgId = createdOrgIds.pop();
      if (orgId) {
        await prisma.organization.delete({ where: { id: orgId } });
      }
    }
  });

  async function createQuoteWithPublicAndPrivateMedia(suffix: string) {
    const token = `quote-token-${suffix}`;
    const org = await prisma.organization.create({
      data: {
        name: `Public Quote Media ${suffix}`,
        slug: `public-quote-media-${suffix}`,
      },
    });
    createdOrgIds.push(org.id);

    const user = await prisma.user.create({
      data: {
        orgId: org.id,
        email: `u-${suffix}@example.com`,
        name: 'Uploader',
        actorType: 'HUMAN',
      },
    });

    const customer = await prisma.customer.create({
      data: {
        orgId: org.id,
        fullName: 'Quote Customer',
      },
    });

    const quote = await prisma.quote.create({
      data: {
        orgId: org.id,
        customerId: customer.id,
        kind: 'SERVICE',
        status: 'SENT',
        publicToken: token,
      },
    });

    const job = await prisma.job.create({
      data: {
        orgId: org.id,
        quoteId: quote.id,
        customerId: customer.id,
        title: 'Linked Job',
        status: 'OPEN',
      },
    });

    const [publicQuotePhoto, privateQuotePhoto, publicJobPhoto] = await Promise.all([
      prisma.attachment.create({
        data: {
          orgId: org.id,
          kind: 'QUOTE_PHOTO',
          storageProvider: 'S3',
          bucket: 'mbs',
          objectKey: `org/${org.id}/quote-public/original.jpg`,
          displayObjectKey: `org/${org.id}/quote-public/display.jpg`,
          thumbObjectKey: `org/${org.id}/quote-public/thumb.jpg`,
          fileName: 'quote-public.jpg',
          mimeType: 'image/jpeg',
          sizeBytes: 1024,
          checksumSha256: 'quote-public-checksum',
          uploadedByUserId: user.id,
          ownerType: 'QUOTE',
          ownerId: quote.id,
          tag: 'AFTER',
          isPublic: true,
        },
      }),
      prisma.attachment.create({
        data: {
          orgId: org.id,
          kind: 'QUOTE_PHOTO',
          storageProvider: 'S3',
          bucket: 'mbs',
          objectKey: `org/${org.id}/quote-private/original.jpg`,
          displayObjectKey: `org/${org.id}/quote-private/display.jpg`,
          thumbObjectKey: `org/${org.id}/quote-private/thumb.jpg`,
          fileName: 'quote-private.jpg',
          mimeType: 'image/jpeg',
          sizeBytes: 1024,
          checksumSha256: 'quote-private-checksum',
          uploadedByUserId: user.id,
          ownerType: 'QUOTE',
          ownerId: quote.id,
          tag: 'BEFORE',
          isPublic: false,
        },
      }),
      prisma.attachment.create({
        data: {
          orgId: org.id,
          kind: 'JOB_PHOTO',
          storageProvider: 'S3',
          bucket: 'mbs',
          objectKey: `org/${org.id}/job-public/original.jpg`,
          displayObjectKey: `org/${org.id}/job-public/display.jpg`,
          thumbObjectKey: `org/${org.id}/job-public/thumb.jpg`,
          fileName: 'job-public.jpg',
          mimeType: 'image/jpeg',
          sizeBytes: 1024,
          checksumSha256: 'job-public-checksum',
          uploadedByUserId: user.id,
          ownerType: 'JOB',
          ownerId: job.id,
          tag: 'INSTALL',
          isPublic: true,
        },
      }),
    ]);

    return {
      token,
      publicQuotePhoto,
      privateQuotePhoto,
      publicJobPhoto,
    };
  }

  it('returns only quote-owned public media on /public/quotes/:token', async () => {
    const fixture = await createQuoteWithPublicAndPrivateMedia(randomUUID().slice(0, 8));
    const response = await request.get(`/public/quotes/${fixture.token}`);
    expect(response.status, JSON.stringify(response.body)).toBe(200);

    const attachmentIds = (response.body?.attachments ?? []).map((row: any) => row.id);
    expect(attachmentIds).toContain(fixture.publicQuotePhoto.id);
    expect(attachmentIds).not.toContain(fixture.privateQuotePhoto.id);
    expect(attachmentIds).not.toContain(fixture.publicJobPhoto.id);
  });

  it('does not fail quote page when storage signing config is unavailable', async () => {
    const fixture = await createQuoteWithPublicAndPrivateMedia(randomUUID().slice(0, 8));
    const prior = {
      accessKey: process.env.S3_ACCESS_KEY,
      secretKey: process.env.S3_SECRET_KEY,
      bucket: process.env.S3_BUCKET,
    };
    delete process.env.S3_ACCESS_KEY;
    delete process.env.S3_SECRET_KEY;
    delete process.env.S3_BUCKET;

    try {
      const response = await request.get(`/public/quotes/${fixture.token}`);
      expect(response.status, JSON.stringify(response.body)).toBe(200);

      const publicAttachment = (response.body?.attachments ?? []).find(
        (row: any) => row.id === fixture.publicQuotePhoto.id,
      );
      expect(publicAttachment).toBeTruthy();
      expect(publicAttachment.mediaAvailable).toBe(false);
      expect(publicAttachment.displayUrl).toBeNull();
      expect(publicAttachment.thumbUrl).toBeNull();
    } finally {
      process.env.S3_ACCESS_KEY = prior.accessKey;
      process.env.S3_SECRET_KEY = prior.secretKey;
      process.env.S3_BUCKET = prior.bucket;
    }
  });
});
