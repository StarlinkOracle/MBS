import type { PrismaClient } from '@rcs/db';

type GeoBucket = {
  zip: string;
  city: string | null;
  geohashPrefix: string;
  leadsCount: number;
  jobsCount: number;
  revenueCents: number;
  spendCents: number;
  reviewsCount: number;
  referralsCount: number;
  closeRatePct: number | null;
};

type RunGeoRollupArgs = {
  orgId: string;
  targetDateKey: string;
};

function toStringOrNull(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function normalizePhone(value: string | null | undefined): string | null {
  if (!value) {
    return null;
  }
  const digits = value.replace(/\D/g, '');
  return digits.length > 0 ? digits : null;
}

function toNumber(value: unknown): number {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : 0;
  }
  if (typeof value === 'bigint') {
    return Number(value);
  }
  if (typeof value === 'string') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

function utcDateFromKey(key: string): Date {
  return new Date(`${key}T00:00:00.000Z`);
}

function nextUtcDay(date: Date): Date {
  return new Date(date.getTime() + 24 * 60 * 60 * 1000);
}

function zipKey(zip: string | null | undefined): string {
  const normalized = toStringOrNull(zip);
  return normalized ?? 'UNKNOWN';
}

function geohashKey(geohash: string | null | undefined, zip: string): string {
  const normalized = toStringOrNull(geohash);
  return normalized ? normalized.slice(0, 5) : `zip:${zip}`;
}

function bucketCompositeKey(zip: string, geohashPrefix: string): string {
  return `${zip}|${geohashPrefix}`;
}

function ensureBucket(
  buckets: Map<string, GeoBucket>,
  input: {
    zip: string;
    city: string | null;
    geohashPrefix: string;
  },
): GeoBucket {
  const key = bucketCompositeKey(input.zip, input.geohashPrefix);
  let bucket = buckets.get(key);
  if (!bucket) {
    bucket = {
      zip: input.zip,
      city: input.city,
      geohashPrefix: input.geohashPrefix,
      leadsCount: 0,
      jobsCount: 0,
      revenueCents: 0,
      spendCents: 0,
      reviewsCount: 0,
      referralsCount: 0,
      closeRatePct: null,
    };
    buckets.set(key, bucket);
  } else if (!bucket.city && input.city) {
    bucket.city = input.city;
  }
  return bucket;
}

async function loadSpendByZip(
  prisma: PrismaClient,
  orgId: string,
  targetDateKey: string,
): Promise<Map<string, { city: string | null; spendCents: number }>> {
  const tableCheck = (await prisma.$queryRawUnsafe(
    `SELECT to_regclass('public."MarketingMetricDaily"')::text as tbl`,
  )) as Array<{ tbl: string | null }>;

  if (!tableCheck[0]?.tbl) {
    return new Map();
  }

  try {
    const rows = (await prisma.$queryRawUnsafe(
        `SELECT COALESCE("zip", 'UNKNOWN') AS zip,
              MAX("city") AS city,
              SUM(COALESCE("spendCents", 0)) AS "spendCents"
         FROM "MarketingMetricDaily"
        WHERE "orgId" = $1
          AND "date" = $2::date
        GROUP BY COALESCE("zip", 'UNKNOWN')`,
      orgId,
      targetDateKey,
    )) as Array<{
      zip: string;
      city: string | null;
      spendCents: number | bigint | string | null;
    }>;

    const map = new Map<string, { city: string | null; spendCents: number }>();
    for (const row of rows) {
      map.set(zipKey(row.zip), {
        city: toStringOrNull(row.city),
        spendCents: toNumber(row.spendCents),
      });
    }
    return map;
  } catch {
    return new Map();
  }
}

export function localDateKey(date: Date, timezone = 'America/Denver'): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);
  const year = parts.find((part) => part.type === 'year')?.value ?? '1970';
  const month = parts.find((part) => part.type === 'month')?.value ?? '01';
  const day = parts.find((part) => part.type === 'day')?.value ?? '01';
  return `${year}-${month}-${day}`;
}

export function shiftDateKey(dateKey: string, days: number): string {
  const date = utcDateFromKey(dateKey);
  date.setUTCDate(date.getUTCDate() + days);
  const year = String(date.getUTCFullYear());
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  const day = String(date.getUTCDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

export async function runGeoRollupDailyForOrg(
  prisma: PrismaClient,
  args: RunGeoRollupArgs,
) {
  const targetDate = utcDateFromKey(args.targetDateKey);
  const rangeStart = targetDate;
  const rangeEnd = nextUtcDay(targetDate);

  const [jobs, invoices, leads, reviews, referrals, spendByZip] = await Promise.all([
    prisma.job.findMany({
      where: {
        orgId: args.orgId,
        status: 'COMPLETED',
        updatedAt: {
          gte: rangeStart,
          lt: rangeEnd,
        },
      },
      select: {
        id: true,
        customerId: true,
        customer: {
          select: {
            city: true,
            postalCode: true,
          },
        },
        jobGeo: {
          select: {
            city: true,
            zip: true,
            geohash: true,
          },
        },
      },
    }),
    prisma.invoice.findMany({
      where: {
        orgId: args.orgId,
        createdAt: {
          gte: rangeStart,
          lt: rangeEnd,
        },
      },
      select: {
        amountCents: true,
        customer: {
          select: {
            city: true,
            postalCode: true,
          },
        },
      },
    }),
    prisma.lead.findMany({
      where: {
        orgId: args.orgId,
        createdAt: {
          gte: rangeStart,
          lt: rangeEnd,
        },
      },
      select: {
        email: true,
        phone: true,
      },
    }),
    prisma.reviewRequest.findMany({
      where: {
        orgId: args.orgId,
        status: 'SENT',
        sentAt: {
          gte: rangeStart,
          lt: rangeEnd,
        },
      },
      select: {
        customer: {
          select: {
            city: true,
            postalCode: true,
          },
        },
        job: {
          select: {
            jobGeo: {
              select: {
                city: true,
                zip: true,
                geohash: true,
              },
            },
          },
        },
      },
    }),
    prisma.referralEvent.findMany({
      where: {
        orgId: args.orgId,
        createdAt: {
          gte: rangeStart,
          lt: rangeEnd,
        },
      },
      select: {
        status: true,
        referredCustomer: {
          select: {
            city: true,
            postalCode: true,
          },
        },
        referrerCustomer: {
          select: {
            city: true,
            postalCode: true,
          },
        },
      },
    }),
    loadSpendByZip(prisma, args.orgId, args.targetDateKey),
  ]);

  const buckets = new Map<string, GeoBucket>();

  for (const job of jobs) {
    const zip = zipKey(job.jobGeo?.zip ?? job.customer?.postalCode);
    const city = toStringOrNull(job.jobGeo?.city ?? job.customer?.city);
    const geohashPrefix = geohashKey(job.jobGeo?.geohash, zip);
    const bucket = ensureBucket(buckets, { zip, city, geohashPrefix });
    bucket.jobsCount += 1;
  }

  for (const invoice of invoices) {
    const zip = zipKey(invoice.customer?.postalCode);
    const city = toStringOrNull(invoice.customer?.city);
    const geohashPrefix = geohashKey(null, zip);
    const bucket = ensureBucket(buckets, { zip, city, geohashPrefix });
    bucket.revenueCents += toNumber(invoice.amountCents);
  }

  const leadEmails = Array.from(
    new Set(
      leads
        .map((lead) => toStringOrNull(lead.email)?.toLowerCase() ?? null)
        .filter((value): value is string => Boolean(value)),
    ),
  );
  const leadPhones = Array.from(
    new Set(
      leads
        .map((lead) => normalizePhone(lead.phone))
        .filter((value): value is string => Boolean(value)),
    ),
  );

  const matchingCustomers = await prisma.customer.findMany({
    where: {
      orgId: args.orgId,
      OR: [
        ...(leadEmails.length > 0
          ? [{ email: { in: leadEmails } }]
          : []),
        ...(leadPhones.length > 0
          ? [{ phone: { in: leadPhones } }]
          : []),
      ],
    },
    select: {
      email: true,
      phone: true,
      city: true,
      postalCode: true,
    },
  });

  const customerByEmail = new Map<string, { city: string | null; zip: string | null }>();
  const customerByPhone = new Map<string, { city: string | null; zip: string | null }>();

  for (const customer of matchingCustomers) {
    const city = toStringOrNull(customer.city);
    const zip = toStringOrNull(customer.postalCode);
    const emailKey = toStringOrNull(customer.email)?.toLowerCase();
    const phoneKey = normalizePhone(customer.phone);
    if (emailKey && !customerByEmail.has(emailKey)) {
      customerByEmail.set(emailKey, { city, zip });
    }
    if (phoneKey && !customerByPhone.has(phoneKey)) {
      customerByPhone.set(phoneKey, { city, zip });
    }
  }

  for (const lead of leads) {
    const emailKey = toStringOrNull(lead.email)?.toLowerCase() ?? null;
    const phoneKey = normalizePhone(lead.phone);
    const match =
      (emailKey ? customerByEmail.get(emailKey) : undefined) ??
      (phoneKey ? customerByPhone.get(phoneKey) : undefined);
    if (!match || !match.zip) {
      continue;
    }

    const zip = zipKey(match.zip);
    const city = toStringOrNull(match.city);
    const geohashPrefix = geohashKey(null, zip);
    const bucket = ensureBucket(buckets, { zip, city, geohashPrefix });
    bucket.leadsCount += 1;
  }

  for (const review of reviews) {
    const zip = zipKey(review.job?.jobGeo?.zip ?? review.customer?.postalCode);
    const city = toStringOrNull(review.job?.jobGeo?.city ?? review.customer?.city);
    const geohashPrefix = geohashKey(review.job?.jobGeo?.geohash, zip);
    const bucket = ensureBucket(buckets, { zip, city, geohashPrefix });
    bucket.reviewsCount += 1;
  }

  for (const referral of referrals) {
    const isCountable =
      referral.status === 'LEAD_CREATED' ||
      referral.status === 'WON' ||
      referral.status === 'REWARDED';
    if (!isCountable) {
      continue;
    }
    const zip = zipKey(
      referral.referredCustomer?.postalCode ??
        referral.referrerCustomer?.postalCode,
    );
    const city = toStringOrNull(
      referral.referredCustomer?.city ?? referral.referrerCustomer?.city,
    );
    const geohashPrefix = geohashKey(null, zip);
    const bucket = ensureBucket(buckets, { zip, city, geohashPrefix });
    bucket.referralsCount += 1;
  }

  for (const [zip, spend] of spendByZip.entries()) {
    const bucket = ensureBucket(buckets, {
      zip,
      city: spend.city,
      geohashPrefix: geohashKey(null, zip),
    });
    bucket.spendCents += spend.spendCents;
  }

  const rows = Array.from(buckets.values()).map((bucket) => {
    const closeRate =
      bucket.leadsCount > 0
        ? Math.round((bucket.jobsCount / bucket.leadsCount) * 10000) / 100
        : null;

    return {
      orgId: args.orgId,
      date: targetDate,
      zip: bucket.zip,
      city: bucket.city,
      geohashPrefix: bucket.geohashPrefix,
      leadsCount: bucket.leadsCount,
      jobsCount: bucket.jobsCount,
      revenueCents: bucket.revenueCents,
      spendCents: bucket.spendCents,
      reviewsCount: bucket.reviewsCount,
      referralsCount: bucket.referralsCount,
      closeRatePct: closeRate,
    };
  });

  await prisma.$transaction(async (tx) => {
    await tx.geoRollupDaily.deleteMany({
      where: {
        orgId: args.orgId,
        date: targetDate,
      },
    });

    if (rows.length > 0) {
      await tx.geoRollupDaily.createMany({
        data: rows,
      });
    }
  });

  return {
    orgId: args.orgId,
    targetDateKey: args.targetDateKey,
    rowsWritten: rows.length,
  };
}
