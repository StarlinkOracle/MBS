import { randomUUID } from 'node:crypto';

import {
  afterAll,
  beforeAll,
  describe,
  expect,
  it,
} from 'vitest';
import supertest from 'supertest';

const describeIfDb = process.env.DATABASE_URL ? describe : describe.skip;

describeIfDb('media upload session status endpoint', () => {
  let request: ReturnType<typeof supertest>;
  let prisma: any;
  let orgId = '';
  let orgSlug = 'russell-comfort';
  let adminUserId = '';

  const createdSessionIds: string[] = [];
  const createdAttachmentIds: string[] = [];
  const createdQuoteIds: string[] = [];
  const createdCustomerIds: string[] = [];

  beforeAll(async () => {
    const [{ app }, db] = await Promise.all([
      import('../src/index.js'),
      import('@rcs/db'),
    ]);
    request = supertest(app);
    prisma = db.prisma;

    const org = await prisma.organization.findUnique({
      where: { slug: orgSlug },
      select: { id: true, slug: true },
    });
    if (!org) {
      throw new Error('Seed org russell-comfort is required');
    }
    orgId = org.id;
    orgSlug = org.slug;

    const admin = await prisma.user.findFirst({
      where: {
        orgId,
        email: 'admin@russellcomfort.com',
        isActive: true,
      },
      select: { id: true },
    });
    if (!admin) {
      throw new Error('Seed admin user is required');
    }
    adminUserId = admin.id;
  });

  afterAll(async () => {
    for (const sessionId of createdSessionIds) {
      await prisma.mediaUploadSession.deleteMany({ where: { id: sessionId } });
    }
    for (const attachmentId of createdAttachmentIds) {
      await prisma.attachment.deleteMany({ where: { id: attachmentId } });
    }
    for (const quoteId of createdQuoteIds) {
      await prisma.quote.deleteMany({ where: { id: quoteId } });
    }
    for (const customerId of createdCustomerIds) {
      await prisma.customer.deleteMany({ where: { id: customerId } });
    }
  });

  it('returns completed session with linked attachment', async () => {
    const suffix = randomUUID().slice(0, 8);
    const sessionKey = `photo-session-${suffix}`;

    const customer = await prisma.customer.create({
      data: {
        orgId,
        fullName: `Upload Session Customer ${suffix}`,
      },
      select: { id: true },
    });
    createdCustomerIds.push(customer.id);

    const quote = await prisma.quote.create({
      data: {
        orgId,
        customerId: customer.id,
        kind: 'SERVICE',
        status: 'DRAFT',
      },
      select: { id: true },
    });
    createdQuoteIds.push(quote.id);

    const attachmentId = `att-${suffix}`;
    await prisma.attachment.create({
      data: {
        id: attachmentId,
        orgId,
        kind: 'QUOTE_PHOTO',
        storageProvider: 'S3',
        bucket: 'mbs',
        objectKey: `org/${orgId}/${suffix}/original.jpg`,
        displayObjectKey: `org/${orgId}/${suffix}/display.jpg`,
        thumbObjectKey: `org/${orgId}/${suffix}/thumb.jpg`,
        fileName: 'session.jpg',
        mimeType: 'image/jpeg',
        sizeBytes: 2048,
        checksumSha256: `checksum-${suffix}`,
        uploadedByUserId: adminUserId,
        ownerType: 'QUOTE',
        ownerId: quote.id,
        tag: 'OTHER',
      },
    });
    createdAttachmentIds.push(attachmentId);

    const session = await prisma.mediaUploadSession.create({
      data: {
        orgId,
        sessionKey,
        status: 'COMPLETED',
        ownerType: 'QUOTE',
        ownerId: quote.id,
        tag: 'OTHER',
        attachmentId,
        fileName: 'session.jpg',
        mimeType: 'image/jpeg',
        sizeBytes: 2048,
        checksumSha256: `checksum-${suffix}`,
        bucket: 'mbs',
        objectKey: `org/${orgId}/${suffix}/original.jpg`,
        displayObjectKey: `org/${orgId}/${suffix}/display.jpg`,
        thumbObjectKey: `org/${orgId}/${suffix}/thumb.jpg`,
        completedAt: new Date(),
        createdByUserId: adminUserId,
      },
      select: { id: true },
    });
    createdSessionIds.push(session.id);

    const response = await request
      .get(`/api/media/upload/session/${encodeURIComponent(sessionKey)}`)
      .set('x-org-slug', orgSlug)
      .set('x-actor-user-id', adminUserId);

    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(response.body?.session?.sessionKey).toBe(sessionKey);
    expect(response.body?.session?.status).toBe('COMPLETED');
    expect(response.body?.attachment?.id).toBe(attachmentId);
  });

  it('returns 404 when upload session is not found', async () => {
    const response = await request
      .get(`/api/media/upload/session/${encodeURIComponent(`missing-${Date.now()}`)}`)
      .set('x-org-slug', orgSlug)
      .set('x-actor-user-id', adminUserId);

    expect(response.status).toBe(404);
    expect(typeof response.body?.error).toBe('string');
  });
});
