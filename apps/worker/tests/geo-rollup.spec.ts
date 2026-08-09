import { randomUUID } from 'node:crypto';

import {
  ActorType,
  PrismaClient,
  ReferralRewardType,
  ReferralEventStatus,
  ReviewRequestChannel,
  ReviewRequestStatus,
} from '@rcs/db';
import {
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
} from 'vitest';

import { runGeoRollupDailyForOrg } from '../src/geo-rollup.js';

const describeIfDb = process.env.DATABASE_URL ? describe : describe.skip;

describeIfDb('geo rollup daily worker', () => {
  const prisma = new PrismaClient();
  let orgId = '';

  beforeAll(async () => {
    await prisma.$connect();
    await prisma.$executeRawUnsafe(`
      CREATE TABLE IF NOT EXISTS "MarketingMetricDaily" (
        "id" TEXT NOT NULL DEFAULT gen_random_uuid(),
        "orgId" TEXT NOT NULL,
        "date" DATE NOT NULL,
        "zip" TEXT,
        "city" TEXT,
        "spendCents" INTEGER NOT NULL DEFAULT 0
      )
    `);
  });

  afterEach(async () => {
    if (orgId) {
      await prisma.$executeRawUnsafe(
        `DELETE FROM "MarketingMetricDaily" WHERE "orgId" = $1`,
        orgId,
      );
      await prisma.organization.delete({
        where: { id: orgId },
      });
    }
    orgId = '';
  });

  it('produces rollup rows for zips present in leads/jobs and joins spend metrics', async () => {
    const suffix = randomUUID().slice(0, 8);
    const now = new Date();
    const targetDateKey = now.toISOString().slice(0, 10);
    const targetDate = new Date(`${targetDateKey}T12:00:00.000Z`);

    const org = await prisma.organization.create({
      data: {
        name: `Geo Rollup ${suffix}`,
        slug: `geo-rollup-${suffix}`,
      },
    });
    orgId = org.id;

    const user = await prisma.user.create({
      data: {
        orgId,
        email: `geo-rollup-${suffix}@example.com`,
        name: 'Geo Rollup User',
      },
    });

    const customer = await prisma.customer.create({
      data: {
        orgId,
        fullName: 'Geo Customer',
        email: `lead-${suffix}@example.com`,
        phone: '+17205551234',
        city: 'Denver',
        postalCode: '80212',
      },
    });

    await prisma.lead.create({
      data: {
        orgId,
        fullName: 'Geo Lead',
        email: customer.email,
        phone: customer.phone,
        createdAt: targetDate,
      },
    });

    const job = await prisma.job.create({
      data: {
        orgId,
        customerId: customer.id,
        title: 'Completed Job',
        status: 'COMPLETED',
        createdAt: targetDate,
        updatedAt: targetDate,
      },
    });

    await prisma.jobGeo.create({
      data: {
        orgId,
        jobId: job.id,
        source: 'PROPERTY_ADDRESS',
        addressNormalized: '123 Main St, Denver, CO 80212',
        city: 'Denver',
        state: 'CO',
        zip: '80212',
        lat: null,
        lng: null,
        geohash: null,
      },
    });

    await prisma.invoice.create({
      data: {
        orgId,
        customerId: customer.id,
        amountCents: 125000,
        status: 'PAID',
        createdAt: targetDate,
      },
    });

    await prisma.reviewRequest.create({
      data: {
        orgId,
        customerId: customer.id,
        jobId: job.id,
        channel: ReviewRequestChannel.SMS,
        status: ReviewRequestStatus.SENT,
        destination: '+17205551234',
        messageDraft: 'Please leave us a review',
        sentAt: targetDate,
        createdByType: ActorType.HUMAN,
        createdByUserId: user.id,
      },
    });

    const referralProgram = await prisma.referralProgram.create({
      data: {
        orgId,
        name: 'Standard Referral',
        isActive: true,
        rewardType: ReferralRewardType.CREDIT,
        rewardValueCents: 2500,
        terms: {},
      },
    });

    await prisma.referralEvent.create({
      data: {
        orgId,
        programId: referralProgram.id,
        referrerCustomerId: customer.id,
        referredCustomerId: customer.id,
        status: ReferralEventStatus.WON,
        createdAt: targetDate,
      },
    });

    await prisma.$executeRawUnsafe(
      `INSERT INTO "MarketingMetricDaily" ("orgId", "date", "zip", "city", "spendCents")
       VALUES ($1, $2::date, $3, $4, $5)`,
      orgId,
      targetDateKey,
      '80212',
      'Denver',
      32100,
    );

    const result = await runGeoRollupDailyForOrg(prisma, {
      orgId,
      targetDateKey,
    });

    expect(result.rowsWritten).toBeGreaterThan(0);

    const rows = await prisma.geoRollupDaily.findMany({
      where: {
        orgId,
        date: new Date(`${targetDateKey}T00:00:00.000Z`),
      },
    });
    expect(rows.length).toBeGreaterThan(0);

    const denverZipRows = rows.filter((row) => row.zip === '80212');
    const totals = denverZipRows.reduce(
      (acc, row) => {
        acc.leads += row.leadsCount;
        acc.jobs += row.jobsCount;
        acc.revenue += row.revenueCents;
        acc.spend += row.spendCents;
        return acc;
      },
      { leads: 0, jobs: 0, revenue: 0, spend: 0 },
    );

    expect(totals.leads).toBeGreaterThanOrEqual(1);
    expect(totals.jobs).toBeGreaterThanOrEqual(1);
    expect(totals.revenue).toBeGreaterThanOrEqual(125000);
    expect(totals.spend).toBeGreaterThanOrEqual(32100);
  });
});
