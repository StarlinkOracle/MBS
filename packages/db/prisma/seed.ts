import {
  ActorType,
  AutonomyLevel,
  Prisma,
  PrismaClient,
  RiskLevel,
  SafetyMode,
} from '@prisma/client';
import bcrypt from 'bcryptjs';

const prisma = new PrismaClient();

type ToolSeed = {
  name: string;
  description: string;
  handlerKey: string;
  riskLevel: RiskLevel;
  autonomyLevel: AutonomyLevel;
  requiredPermissions: string[];
  inputSchema: Record<string, unknown>;
  cooldownSeconds?: number;
  maxCallsPerRun?: number;
  requiresReason?: boolean;
  requiresSnapshot?: boolean;
  endpointAllowsHumanOverride?: boolean;
};

const permissions = [
  { key: '*', description: 'Global superuser access' },
  { key: 'crm:*', description: 'CRM full access' },
  { key: 'crm:read', description: 'CRM read access' },
  { key: 'crm:write', description: 'CRM write access' },
  { key: 'jobs:*', description: 'Jobs full access' },
  { key: 'jobs:read', description: 'Jobs read access' },
  { key: 'jobs:write', description: 'Jobs write access' },
  { key: 'billing:*', description: 'Billing full access' },
  { key: 'billing:write', description: 'Billing write access' },
  { key: 'accounting:read', description: 'Accounting read access' },
  { key: 'accounting:write', description: 'Accounting write access' },
  { key: 'marketing:*', description: 'Marketing full access' },
  { key: 'marketing:write', description: 'Marketing write access' },
  { key: 'reporting:*', description: 'Reporting access' },
  { key: 'auth:*', description: 'Authorization administration' },
  { key: 'system:*', description: 'System administration' },
  { key: 'system:killswitch:read', description: 'Read kill switch state' },
  { key: 'system:killswitch:write', description: 'Update kill switch state' },
  { key: 'system:policy:read', description: 'Read policy definitions' },
  { key: 'system:policy:write', description: 'Update policy definitions' },
  { key: 'system:ops:read', description: 'Read system health and reliability snapshots' },
  { key: 'finance:exposure:read', description: 'Read financial exposure totals' },
  { key: 'integration:jobber:import', description: 'Import Jobber CSV data into MBS' },
  { key: 'catalog:equipment:read', description: 'Search imported equipment catalog entries' },
  { key: 'catalog:equipment:write', description: 'Import and manage equipment catalog data' },
  { key: 'integration:website:ingest', description: 'Ingest website submissions into MBS intake endpoints' },
  { key: 'crm:lead:read', description: 'Read lead profiles, pipeline state, and SLA evaluations' },
  { key: 'crm:lead:write', description: 'Create/update leads from intake and operator actions' },
  { key: 'crm:task:write', description: 'Create/update sales SLA tasks' },
  { key: 'crm:timeline:write', description: 'Create timeline entries for CRM entities' },
  { key: 'crm:attachment:write', description: 'Create attachment references for CRM workflows' },
  { key: 'marketing:attribution:write', description: 'Capture marketing attribution events' },
  { key: 'accounting:receipt:ocr', description: 'Run OCR extraction on receipt images' },
  { key: 'jobs:geo:write', description: 'Create and update job geotags' },
  { key: 'marketing:reviews:write', description: 'Manage review request workflows' },
  { key: 'marketing:referrals:write', description: 'Manage referral programs and events' },
  { key: 'pricebook:cost:read', description: 'Read internal cost values in pricebook/admin workflows' },
  { key: 'crm:service_quote:read', description: 'Read service quote builder records and breakdowns' },
  { key: 'crm:service_quote:write', description: 'Create and modify service quotes and line items' },
  { key: 'crm:quote:read', description: 'Read install/service quote lifecycle and public token state' },
  { key: 'crm:quote:write', description: 'Send/accept/convert quotes in the quote-to-job loop' },
  { key: 'contract:read', description: 'Read governed legal clauses, templates, and pack metadata' },
  { key: 'contract:write', description: 'Create and update governed legal draft artifacts' },
  { key: 'contract:publish', description: 'Publish governed legal clauses/templates' },
  { key: 'integration:legalpack:import', description: 'Import legal artifact packs through governed tools' },
  { key: 'scheduling:read', description: 'Read scheduling capacity and appointment availability' },
  { key: 'scheduling:write', description: 'Create/update scheduling settings and appointments' },
  { key: 'pricebook:manage', description: 'Manage service pricebook categories and items' },
  { key: 'bundles:manage', description: 'Manage service bundle templates' },
  { key: 'pricing:discount:apply_pct', description: 'Apply percentage discounts to install quote options' },
  { key: 'pricing:discount:apply_cents', description: 'Apply fixed-dollar discounts to install quote options' },
  { key: 'pricing:discount:override_limits', description: 'Override default discount approval thresholds' },
  { key: 'pricing:block:override', description: 'Owner-only override for pricing guardrail blocks' },
  { key: 'media:read', description: 'Read quote and job media attachments' },
  { key: 'media:write', description: 'Upload and delete quote/job media attachments' },
  { key: 'media:share', description: 'Control public sharing of quote photos' },
  { key: 'media:purge', description: 'Run media retention purge operations' },
  { key: 'comms:read', description: 'Read communications inbox threads and messages' },
  { key: 'comms:write', description: 'Create communications drafts and triage updates' },
  { key: 'comms:sync', description: 'Run communications connector sync operations' },
  { key: 'comms:send', description: 'Approve and send outbound communications' },
  { key: 'comms:triage', description: 'Link threads and manage triage workflow' },
  { key: 'mobile:sync', description: 'Use mobile offline sync push/pull APIs' },
  { key: 'time:read', description: 'Read time entries and edit requests' },
  { key: 'time:write', description: 'Clock in/out, breaks, and job timers' },
  { key: 'time:edit:request', description: 'Request edits to existing time entries' },
  { key: 'time:edit:review', description: 'Approve or reject time edit requests' },
  { key: 'auth:mobile:pin:set', description: 'Set mobile PIN credentials for users' },
  { key: 'auth:mobile:pin:reset', description: 'Reset mobile PIN credentials for users' },
];

const roleDefinitions: Record<string, string[]> = {
  admin: ['*'],
  dispatcher: ['crm:read', 'crm:write', 'crm:lead:read', 'crm:quote:read', 'jobs:*', 'scheduling:read', 'scheduling:write', 'media:read', 'media:write', 'media:share', 'comms:read', 'comms:write', 'comms:triage', 'time:read', 'time:write', 'time:edit:review', 'mobile:sync', 'auth:mobile:pin:set', 'auth:mobile:pin:reset', 'system:ops:read', 'reporting:*'],
  billing_manager: [
    'crm:read',
    'crm:write',
    'crm:service_quote:read',
    'crm:service_quote:write',
    'crm:quote:read',
    'crm:quote:write',
    'billing:*',
    'accounting:read',
    'accounting:write',
    'reporting:*',
    'pricebook:cost:read',
    'pricing:discount:apply_pct',
    'pricing:discount:apply_cents',
    'system:ops:read',
    'auth:mobile:pin:set',
    'auth:mobile:pin:reset',
  ],
  sales_rep: [
    'crm:read',
    'crm:write',
    'crm:lead:read',
    'crm:service_quote:read',
    'crm:service_quote:write',
    'media:read',
    'media:write',
    'media:share',
    'marketing:write',
    'billing:write',
    'comms:read',
    'comms:write',
    'comms:triage',
    'comms:send',
    'mobile:sync',
    'time:read',
    'time:write',
    'time:edit:request',
    'pricing:discount:apply_pct',
    'pricing:discount:apply_cents',
  ],
  tech: [
    'crm:read',
    'crm:lead:read',
    'jobs:read',
    'jobs:write',
    'media:read',
    'media:write',
    'time:read',
    'time:write',
    'time:edit:request',
    'mobile:sync',
  ],
  master_agent: [
    'crm:read',
    'crm:lead:read',
    'crm:write',
    'crm:lead:write',
    'crm:task:write',
    'crm:timeline:write',
    'crm:attachment:write',
    'contract:read',
    'contract:write',
    'marketing:attribution:write',
    'integration:website:ingest',
    'comms:read',
    'comms:write',
    'comms:triage',
    'jobs:read',
    'jobs:write',
    'reporting:*',
    'marketing:write',
    'billing:write',
  ],
};

const toolCatalog: ToolSeed[] = [
  {
    name: 'reporting.context.build',
    description: 'Build context payload from CRM, jobs, and billing state.',
    handlerKey: 'reporting.context.build',
    riskLevel: RiskLevel.LOW,
    autonomyLevel: AutonomyLevel.ALWAYS_ALLOWED,
    requiredPermissions: ['reporting:*'],
    inputSchema: { type: 'object', additionalProperties: false, properties: {} },
    requiresSnapshot: true,
  },
  {
    name: 'crm.lead.create',
    description: 'Create or upsert a lead from web form or operator action.',
    handlerKey: 'crm.lead.create',
    riskLevel: RiskLevel.MEDIUM,
    autonomyLevel: AutonomyLevel.ALWAYS_ALLOWED,
    requiredPermissions: ['crm:write'],
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        fullName: { type: 'string' },
        email: { type: 'string' },
        phone: { type: 'string' },
        status: { type: 'string' },
        score: { type: 'integer' },
        notes: { type: 'string' },
      },
      required: ['fullName'],
    },
  },
  {
    name: 'lead.profile.upsert',
    description: 'Create or update governed lead profile metadata.',
    handlerKey: 'lead.profile.upsert',
    riskLevel: RiskLevel.LOW,
    autonomyLevel: AutonomyLevel.ALWAYS_ALLOWED,
    requiredPermissions: ['crm:lead:write'],
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        leadId: { type: 'string' },
        sourceLeadId: { type: 'string' },
        leadType: { type: 'string', enum: ['RESIDENTIAL_SINGLE', 'RESIDENTIAL_MULTI_PROPERTY', 'COMMERCIAL'] },
        displayName: { type: 'string' },
        primaryContact: {
          type: 'object',
          additionalProperties: false,
          properties: {
            name: { type: 'string' },
            email: { type: 'string' },
            phone: { type: 'string' },
          },
        },
        company: {
          type: 'object',
          additionalProperties: false,
          properties: {
            legalName: { type: 'string' },
            dba: { type: 'string' },
            website: { type: 'string' },
          },
        },
        tags: { type: 'array', items: { type: 'string' } },
        notes: { type: 'string' },
        requestId: { type: 'string' },
      },
      required: ['leadType'],
    },
  },
  {
    name: 'lead.site.upsert',
    description: 'Create or update governed lead site information.',
    handlerKey: 'lead.site.upsert',
    riskLevel: RiskLevel.LOW,
    autonomyLevel: AutonomyLevel.ALWAYS_ALLOWED,
    requiredPermissions: ['crm:lead:write'],
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        leadId: { type: 'string' },
        siteId: { type: 'string' },
        label: { type: 'string' },
        address: {
          type: 'object',
          additionalProperties: false,
          properties: {
            line1: { type: 'string' },
            line2: { type: 'string' },
            city: { type: 'string' },
            state: { type: 'string' },
            postalCode: { type: 'string' },
          },
          required: ['line1', 'city', 'state', 'postalCode'],
        },
        property: {
          type: 'object',
          additionalProperties: false,
          properties: {
            propertyType: { type: 'string', enum: ['RESIDENTIAL', 'COMMERCIAL'] },
            units: { type: 'integer', minimum: 1 },
            sqft: { type: 'integer', minimum: 1 },
            yearBuilt: { type: 'integer' },
          },
        },
        commercial: {
          type: 'object',
          additionalProperties: false,
          properties: {
            rtuCount: { type: 'integer', minimum: 0 },
            rooftopAccessType: { type: 'string', enum: ['NONE', 'HATCH', 'LADDER', 'STAIRS', 'UNKNOWN'] },
            rooftopAccessNotes: { type: 'string' },
          },
        },
        siteNotes: { type: 'string' },
        requestId: { type: 'string' },
      },
      required: ['leadId', 'address'],
    },
  },
  {
    name: 'lead.stage.update',
    description: 'Transition a lead stage with SLA and next action discipline.',
    handlerKey: 'lead.stage.update',
    riskLevel: RiskLevel.MEDIUM,
    autonomyLevel: AutonomyLevel.ALWAYS_ALLOWED,
    requiredPermissions: ['crm:lead:write'],
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        leadId: { type: 'string' },
        toStage: { type: 'string', enum: ['NEW', 'CONTACTED', 'QUALIFIED', 'APPOINTMENT_SET', 'ESTIMATE_SENT', 'WON', 'LOST', 'NURTURE'] },
        reason: { type: 'string' },
        lostOutcome: { type: 'string', enum: ['NO_CONTACT', 'NO_SHOW', 'PRICE', 'TIMING', 'COMPETITOR', 'NOT_A_FIT', 'DUPLICATE', 'OTHER'] },
        lostNotes: { type: 'string' },
        requestId: { type: 'string' },
      },
      required: ['leadId', 'toStage'],
    },
  },
  {
    name: 'lead.owner.assign',
    description: 'Assign an owner to a lead.',
    handlerKey: 'lead.owner.assign',
    riskLevel: RiskLevel.LOW,
    autonomyLevel: AutonomyLevel.ALWAYS_ALLOWED,
    requiredPermissions: ['crm:lead:write'],
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        leadId: { type: 'string' },
        ownerUserId: { type: 'string' },
        reason: { type: 'string' },
        requestId: { type: 'string' },
      },
      required: ['leadId', 'ownerUserId'],
    },
  },
  {
    name: 'lead.touch.record',
    description: 'Record a lead touch and roll SLA timers forward.',
    handlerKey: 'lead.touch.record',
    riskLevel: RiskLevel.LOW,
    autonomyLevel: AutonomyLevel.ALWAYS_ALLOWED,
    requiredPermissions: ['crm:lead:write'],
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        leadId: { type: 'string' },
        channel: { type: 'string', enum: ['CALL', 'TEXT', 'EMAIL', 'IN_PERSON', 'OTHER'] },
        direction: { type: 'string', enum: ['INBOUND', 'OUTBOUND'] },
        summary: { type: 'string' },
        outcome: { type: 'string', enum: ['CONNECTED', 'LEFT_MESSAGE', 'NO_ANSWER', 'BOUNCED', 'SENT', 'RECEIVED', 'OTHER'] },
        relatedCommsThreadId: { type: 'string' },
        requestId: { type: 'string' },
      },
      required: ['leadId', 'channel', 'direction', 'summary'],
    },
  },
  {
    name: 'lead.nextAction.set',
    description: 'Set or replace a governed lead next action task.',
    handlerKey: 'lead.nextAction.set',
    riskLevel: RiskLevel.LOW,
    autonomyLevel: AutonomyLevel.ALWAYS_ALLOWED,
    requiredPermissions: ['crm:task:write'],
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        leadId: { type: 'string' },
        task: {
          type: 'object',
          additionalProperties: false,
          properties: {
            title: { type: 'string' },
            description: { type: 'string' },
            dueAt: { type: 'string' },
            ownerUserId: { type: 'string' },
            priority: { type: 'string', enum: ['LOW', 'NORMAL', 'HIGH'] },
            type: { type: 'string', enum: ['FOLLOW_UP', 'SCHEDULE', 'ESTIMATE', 'DOCS', 'OTHER'] },
          },
          required: ['title', 'dueAt'],
        },
        replaceExisting: { type: 'boolean' },
        requestId: { type: 'string' },
      },
      required: ['leadId', 'task'],
    },
  },
  {
    name: 'lead.sla.evaluate',
    description: 'Evaluate lead SLA status and escalation recommendation.',
    handlerKey: 'lead.sla.evaluate',
    riskLevel: RiskLevel.LOW,
    autonomyLevel: AutonomyLevel.ALWAYS_ALLOWED,
    requiredPermissions: ['crm:lead:read'],
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        leadId: { type: 'string' },
      },
      required: ['leadId'],
    },
  },
  {
    name: 'lead.nurture.enroll',
    description: 'Enroll lead into governed nurture cadence.',
    handlerKey: 'lead.nurture.enroll',
    riskLevel: RiskLevel.MEDIUM,
    autonomyLevel: AutonomyLevel.ALWAYS_ALLOWED,
    requiredPermissions: ['crm:lead:write'],
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        leadId: { type: 'string' },
        cadence: { type: 'string', enum: ['WEEKLY', 'BIWEEKLY', 'MONTHLY'] },
        channels: { type: 'array', items: { type: 'string', enum: ['TEXT', 'EMAIL'] }, minItems: 1 },
        startAt: { type: 'string' },
        notes: { type: 'string' },
        requestId: { type: 'string' },
      },
      required: ['leadId', 'cadence', 'channels'],
    },
  },
  {
    name: 'crm.lead.list',
    description: 'List leads for qualification.',
    handlerKey: 'crm.lead.list',
    riskLevel: RiskLevel.LOW,
    autonomyLevel: AutonomyLevel.ALWAYS_ALLOWED,
    requiredPermissions: ['crm:read'],
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        status: { type: 'string' },
      },
    },
  },
  {
    name: 'crm.customer.get',
    description: 'Fetch a single customer record.',
    handlerKey: 'crm.customer.get',
    riskLevel: RiskLevel.LOW,
    autonomyLevel: AutonomyLevel.ALWAYS_ALLOWED,
    requiredPermissions: ['crm:read'],
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        customerId: { type: 'string' },
      },
      required: ['customerId'],
    },
  },
  {
    name: 'jobs.list',
    description: 'List jobs by status.',
    handlerKey: 'jobs.list',
    riskLevel: RiskLevel.LOW,
    autonomyLevel: AutonomyLevel.ALWAYS_ALLOWED,
    requiredPermissions: ['jobs:read'],
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        status: { type: 'string' },
      },
    },
  },
  {
    name: 'crm.lead.score',
    description: 'Score a lead based on profile factors.',
    handlerKey: 'crm.lead.score',
    riskLevel: RiskLevel.LOW,
    autonomyLevel: AutonomyLevel.ALWAYS_ALLOWED,
    requiredPermissions: ['crm:write'],
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        leadId: { type: 'string' },
        score: { type: 'integer', minimum: 0, maximum: 100 },
      },
      required: ['leadId', 'score'],
    },
    maxCallsPerRun: 30,
  },
  {
    name: 'crm.task.create',
    description: 'Create follow-up task for a lead.',
    handlerKey: 'crm.task.create',
    riskLevel: RiskLevel.LOW,
    autonomyLevel: AutonomyLevel.ALWAYS_ALLOWED,
    requiredPermissions: ['crm:write'],
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        leadId: { type: 'string' },
        note: { type: 'string' },
      },
      required: ['leadId', 'note'],
    },
  },
  {
    name: 'crm.lead.upsertFromWebsite',
    description: 'Idempotent website lead upsert for intake ingestion.',
    handlerKey: 'crm.lead.upsertFromWebsite',
    riskLevel: RiskLevel.MEDIUM,
    autonomyLevel: AutonomyLevel.ALWAYS_ALLOWED,
    requiredPermissions: ['integration:website:ingest', 'crm:lead:write'],
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        firstName: { type: 'string' },
        lastName: { type: 'string' },
        fullName: { type: 'string' },
        email: { type: 'string' },
        phone: { type: 'string' },
        address: { type: 'string' },
        city: { type: 'string' },
        state: { type: 'string' },
        zip: { type: 'string' },
        serviceType: { type: 'string' },
        preferredDate: { type: 'string' },
        preferredTime: { type: 'string' },
        message: { type: 'string' },
        source: { type: 'string' },
        leadSource: { type: 'string' },
      },
      required: ['source'],
    },
  },
  {
    name: 'crm.attribution.captureFromWebsite',
    description: 'Capture attribution payload from website submission.',
    handlerKey: 'crm.attribution.captureFromWebsite',
    riskLevel: RiskLevel.LOW,
    autonomyLevel: AutonomyLevel.ALWAYS_ALLOWED,
    requiredPermissions: ['marketing:attribution:write'],
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        leadId: { type: 'string' },
        sourceType: { type: 'string' },
        utmSource: { type: 'string' },
        utmMedium: { type: 'string' },
        utmCampaign: { type: 'string' },
        utmContent: { type: 'string' },
        utmTerm: { type: 'string' },
        gclid: { type: 'string' },
        gbraid: { type: 'string' },
        wbraid: { type: 'string' },
        fbclid: { type: 'string' },
        landingUrl: { type: 'string' },
        referrerUrl: { type: 'string' },
        visitorId: { type: 'string' },
        userAgent: { type: 'string' },
        ipHash: { type: 'string' },
        metadata: { type: 'object' },
      },
      required: ['leadId'],
    },
  },
  {
    name: 'crm.timeline.add',
    description: 'Create a CRM lead timeline event.',
    handlerKey: 'crm.timeline.add',
    riskLevel: RiskLevel.LOW,
    autonomyLevel: AutonomyLevel.ALWAYS_ALLOWED,
    requiredPermissions: ['crm:timeline:write'],
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        leadId: { type: 'string' },
        type: { type: 'string' },
        message: { type: 'string' },
        metadata: { type: 'object' },
      },
      required: ['leadId', 'type', 'message'],
    },
  },
  {
    name: 'crm.task.createSalesSla',
    description: 'Create a sales SLA task for website intake.',
    handlerKey: 'crm.task.createSalesSla',
    riskLevel: RiskLevel.MEDIUM,
    autonomyLevel: AutonomyLevel.ALWAYS_ALLOWED,
    requiredPermissions: ['crm:task:write'],
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        leadId: { type: 'string' },
        kind: { type: 'string', enum: ['CONTACT', 'PRICE_MATCH'] },
        dueInMinutes: { type: 'integer', minimum: 1 },
        priority: { type: 'string', enum: ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'] },
        queue: { type: 'string' },
        metadata: { type: 'object' },
      },
      required: ['leadId', 'kind', 'dueInMinutes', 'priority'],
    },
  },
  {
    name: 'crm.attachmentRef.create',
    description: 'Create a CRM attachment reference for intake workflows.',
    handlerKey: 'crm.attachmentRef.create',
    riskLevel: RiskLevel.LOW,
    autonomyLevel: AutonomyLevel.ALWAYS_ALLOWED,
    requiredPermissions: ['crm:attachment:write'],
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        provider: { type: 'string', enum: ['S3', 'URL'] },
        bucket: { type: 'string' },
        objectKey: { type: 'string' },
        url: { type: 'string' },
        fileName: { type: 'string' },
        mimeType: { type: 'string' },
        sizeBytes: { type: 'integer', minimum: 0 },
        checksumSha256: { type: 'string' },
        metadata: { type: 'object' },
      },
      required: ['provider', 'fileName'],
    },
  },
  {
    name: 'crm.priceMatch.create',
    description: 'Create a website price match request linked to a lead.',
    handlerKey: 'crm.priceMatch.create',
    riskLevel: RiskLevel.MEDIUM,
    autonomyLevel: AutonomyLevel.ALWAYS_ALLOWED,
    requiredPermissions: ['crm:lead:write'],
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        leadId: { type: 'string' },
        competitorName: { type: 'string' },
        competitorPriceCents: { type: 'integer', minimum: 0 },
        notes: { type: 'string' },
        serviceType: { type: 'string' },
        attachmentRefId: { type: 'string' },
        metadata: { type: 'object' },
      },
      required: ['leadId', 'competitorName'],
    },
  },
  {
    name: 'marketing.sms.draft',
    description: 'Draft an SMS message for customer outreach.',
    handlerKey: 'marketing.sms.draft',
    riskLevel: RiskLevel.LOW,
    autonomyLevel: AutonomyLevel.ALWAYS_ALLOWED,
    requiredPermissions: ['marketing:write'],
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        customerId: { type: 'string' },
        template: { type: 'string' },
      },
      required: ['customerId'],
    },
    requiresSnapshot: true,
  },
  {
    name: 'marketing.email.draft',
    description: 'Draft an email message for customer outreach.',
    handlerKey: 'marketing.email.draft',
    riskLevel: RiskLevel.LOW,
    autonomyLevel: AutonomyLevel.ALWAYS_ALLOWED,
    requiredPermissions: ['marketing:write'],
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        customerId: { type: 'string' },
        template: { type: 'string' },
      },
      required: ['customerId'],
    },
    requiresSnapshot: true,
  },
  {
    name: 'reporting.run.summary',
    description: 'Generate a run summary.',
    handlerKey: 'reporting.run.summary',
    riskLevel: RiskLevel.LOW,
    autonomyLevel: AutonomyLevel.ALWAYS_ALLOWED,
    requiredPermissions: ['reporting:*'],
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        agentRunId: { type: 'string' },
      },
      required: ['agentRunId'],
    },
  },
  {
    name: 'crm.note.add',
    description: 'Add note to a lead.',
    handlerKey: 'crm.note.add',
    riskLevel: RiskLevel.LOW,
    autonomyLevel: AutonomyLevel.ALWAYS_ALLOWED,
    requiredPermissions: ['crm:write'],
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        leadId: { type: 'string' },
        note: { type: 'string', minLength: 1 },
      },
      required: ['leadId', 'note'],
    },
  },
  {
    name: 'crm.contact.update',
    description: 'Update customer contact details.',
    handlerKey: 'crm.contact.update',
    riskLevel: RiskLevel.MEDIUM,
    autonomyLevel: AutonomyLevel.REQUIRES_APPROVAL,
    requiredPermissions: ['crm:write'],
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        customerId: { type: 'string' },
        email: { type: 'string' },
        phone: { type: 'string' },
      },
      required: ['customerId'],
    },
  },
  {
    name: 'contracts.renew',
    description: 'Renew customer agreement.',
    handlerKey: 'contracts.renew',
    riskLevel: RiskLevel.MEDIUM,
    autonomyLevel: AutonomyLevel.REQUIRES_APPROVAL,
    requiredPermissions: ['crm:write'],
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        customerId: { type: 'string' },
        termMonths: { type: 'integer', minimum: 1 },
      },
      required: ['customerId', 'termMonths'],
    },
    requiresReason: true,
  },
  {
    name: 'jobs.schedule.change',
    description: 'Move job schedule.',
    handlerKey: 'jobs.schedule.change',
    riskLevel: RiskLevel.MEDIUM,
    autonomyLevel: AutonomyLevel.REQUIRES_APPROVAL,
    requiredPermissions: ['jobs:write'],
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        jobId: { type: 'string' },
        scheduledAt: { type: 'string' },
        status: { type: 'string' },
        addressLine1: { type: 'string' },
        city: { type: 'string' },
        state: { type: 'string' },
        postalCode: { type: 'string' },
        queueSend: { type: 'boolean' },
        reviewChannel: { type: 'string', enum: ['SMS', 'EMAIL'] },
        reviewUrl: { type: 'string' },
      },
      required: ['jobId', 'scheduledAt'],
    },
  },
  {
    name: 'jobs.job.create',
    description: 'Create a new job.',
    handlerKey: 'jobs.job.create',
    riskLevel: RiskLevel.MEDIUM,
    autonomyLevel: AutonomyLevel.REQUIRES_APPROVAL,
    requiredPermissions: ['jobs:write'],
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        customerId: { type: 'string' },
        title: { type: 'string' },
        scheduledAt: { type: 'string' },
        addressLine1: { type: 'string' },
        city: { type: 'string' },
        state: { type: 'string' },
        postalCode: { type: 'string' },
      },
      required: ['title'],
    },
  },
  {
    name: 'jobs.geo.ensure',
    description: 'Ensure geotag exists for a job from property address data.',
    handlerKey: 'jobs.geo.ensure',
    riskLevel: RiskLevel.MEDIUM,
    autonomyLevel: AutonomyLevel.ALWAYS_ALLOWED,
    requiredPermissions: ['jobs:geo:write'],
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        jobId: { type: 'string' },
        addressLine1: { type: 'string' },
        city: { type: 'string' },
        state: { type: 'string' },
        postalCode: { type: 'string' },
      },
      required: ['jobId'],
    },
  },
  {
    name: 'jobs.dispatch.assign',
    description: 'Assign a technician to a job.',
    handlerKey: 'jobs.dispatch.assign',
    riskLevel: RiskLevel.MEDIUM,
    autonomyLevel: AutonomyLevel.REQUIRES_APPROVAL,
    requiredPermissions: ['jobs:write'],
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        jobId: { type: 'string' },
        userId: { type: 'string' },
        addressLine1: { type: 'string' },
        city: { type: 'string' },
        state: { type: 'string' },
        postalCode: { type: 'string' },
      },
      required: ['jobId', 'userId'],
    },
  },
  {
    name: 'crm.lead.updateStage',
    description: 'Advance lead stage and keep opportunity pipeline in sync.',
    handlerKey: 'crm.lead.updateStage',
    riskLevel: RiskLevel.LOW,
    autonomyLevel: AutonomyLevel.ALWAYS_ALLOWED,
    requiredPermissions: ['crm:write'],
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        leadId: { type: 'string' },
        stage: { type: 'string' },
        notes: { type: 'string' },
        valueCents: { type: 'integer', minimum: 0 },
        assignedToUserId: { type: 'string' },
      },
      required: ['leadId', 'stage'],
    },
  },
  {
    name: 'crm.quote.send',
    description: 'Set quote to SENT, issue public token, and emit quote.sent event.',
    handlerKey: 'crm.quote.send',
    riskLevel: RiskLevel.MEDIUM,
    autonomyLevel: AutonomyLevel.ALWAYS_ALLOWED,
    requiredPermissions: ['crm:quote:write'],
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        quoteId: { type: 'string' },
        regenerateToken: { type: 'boolean' },
        expiresInDays: { type: 'integer', minimum: 1, maximum: 60 },
      },
      required: ['quoteId'],
    },
  },
  {
    name: 'crm.quote.accept',
    description: 'Accept quote by public token with signer metadata.',
    handlerKey: 'crm.quote.accept',
    riskLevel: RiskLevel.LOW,
    autonomyLevel: AutonomyLevel.ALWAYS_ALLOWED,
    requiredPermissions: ['crm:quote:write'],
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        quoteToken: { type: 'string' },
        acceptedByName: { type: 'string' },
        notes: { type: 'string' },
        acceptedIpHash: { type: 'string' },
      },
      required: ['quoteToken', 'acceptedByName'],
    },
  },
  {
    name: 'quote.manifest.generate',
    description: 'Generate and persist a deterministic quote manifest snapshot.',
    handlerKey: 'quote.manifest.generate',
    riskLevel: RiskLevel.LOW,
    autonomyLevel: AutonomyLevel.ALWAYS_ALLOWED,
    requiredPermissions: ['crm:quote:write'],
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        quoteId: { type: 'string' },
        optionKey: { type: 'string' },
        requestId: { type: 'string' },
      },
      required: ['quoteId'],
    },
  },
  {
    name: 'quote.manifest.get',
    description: 'Fetch latest quote manifest snapshot.',
    handlerKey: 'quote.manifest.get',
    riskLevel: RiskLevel.LOW,
    autonomyLevel: AutonomyLevel.ALWAYS_ALLOWED,
    requiredPermissions: ['crm:quote:read'],
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        quoteId: { type: 'string' },
      },
      required: ['quoteId'],
    },
  },
  {
    name: 'quote.accept.withEvidence',
    description: 'Record quote acceptance by quote id with evidence payload.',
    handlerKey: 'quote.accept.withEvidence',
    riskLevel: RiskLevel.MEDIUM,
    autonomyLevel: AutonomyLevel.ALWAYS_ALLOWED,
    requiredPermissions: ['crm:quote:write'],
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        quoteId: { type: 'string' },
        acceptedByName: { type: 'string' },
        acceptedAt: { type: 'string' },
        acceptedIpHash: { type: 'string' },
        notes: { type: 'string' },
        evidence: { type: 'object' },
      },
      required: ['quoteId', 'acceptedByName'],
    },
  },
  {
    name: 'contract.preview.fromQuote',
    description: 'Build contract preview payload from quote context.',
    handlerKey: 'contract.preview.fromQuote',
    riskLevel: RiskLevel.LOW,
    autonomyLevel: AutonomyLevel.ALWAYS_ALLOWED,
    requiredPermissions: ['crm:quote:read'],
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        quoteId: { type: 'string' },
        optionKey: { type: 'string' },
        includeLineItems: { type: 'boolean' },
      },
      required: ['quoteId'],
    },
  },
  {
    name: 'contract.draft.createFromQuote',
    description: 'Create deterministic contract draft metadata from quote.',
    handlerKey: 'contract.draft.createFromQuote',
    riskLevel: RiskLevel.MEDIUM,
    autonomyLevel: AutonomyLevel.ALWAYS_ALLOWED,
    requiredPermissions: ['crm:quote:write'],
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        quoteId: { type: 'string' },
        templateId: { type: 'string' },
        signerClassification: { type: 'string' },
        requestId: { type: 'string' },
        notes: { type: 'string' },
      },
      required: ['quoteId'],
    },
  },
  {
    name: 'contract.draft.generatePdf',
    description: 'Generate contract draft PDF artifact metadata.',
    handlerKey: 'contract.draft.generatePdf',
    riskLevel: RiskLevel.LOW,
    autonomyLevel: AutonomyLevel.ALWAYS_ALLOWED,
    requiredPermissions: ['crm:quote:write'],
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        quoteId: { type: 'string' },
        draftId: { type: 'string' },
        requestId: { type: 'string' },
      },
      required: ['quoteId'],
    },
  },
  {
    name: 'contract.signatureEnvelope.createForQuote',
    description: 'Create deterministic signature envelope metadata for quote contract.',
    handlerKey: 'contract.signatureEnvelope.createForQuote',
    riskLevel: RiskLevel.HIGH,
    autonomyLevel: AutonomyLevel.REQUIRES_APPROVAL,
    requiredPermissions: ['crm:quote:write'],
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        quoteId: { type: 'string' },
        draftId: { type: 'string' },
        recipientName: { type: 'string' },
        recipientEmail: { type: 'string' },
        channel: { type: 'string', enum: ['EMAIL', 'SMS'] },
        requestId: { type: 'string' },
      },
      required: ['quoteId'],
    },
  },
  {
    name: 'contract.esign.send',
    description: 'Send signature envelope and record governed dispatch metadata.',
    handlerKey: 'contract.esign.send',
    riskLevel: RiskLevel.HIGH,
    autonomyLevel: AutonomyLevel.REQUIRES_APPROVAL,
    requiredPermissions: ['comms:send'],
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        quoteId: { type: 'string' },
        envelopeId: { type: 'string' },
        requestId: { type: 'string' },
      },
      required: ['quoteId'],
    },
  },
  {
    name: 'contract.finalizeFromQuote',
    description: 'Finalize contract record from accepted quote metadata.',
    handlerKey: 'contract.finalizeFromQuote',
    riskLevel: RiskLevel.HIGH,
    autonomyLevel: AutonomyLevel.REQUIRES_APPROVAL,
    requiredPermissions: ['crm:quote:write'],
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        quoteId: { type: 'string' },
        envelopeId: { type: 'string' },
        requestId: { type: 'string' },
        notes: { type: 'string' },
      },
      required: ['quoteId'],
    },
  },
  {
    name: 'contract.redline.generate',
    description: 'Generate deterministic redline summary from contract text payloads.',
    handlerKey: 'contract.redline.generate',
    riskLevel: RiskLevel.LOW,
    autonomyLevel: AutonomyLevel.ALWAYS_ALLOWED,
    requiredPermissions: ['crm:quote:read'],
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        quoteId: { type: 'string' },
        baselineText: { type: 'string' },
        proposedText: { type: 'string' },
        requestId: { type: 'string' },
      },
    },
  },
  {
    name: 'contract.references.extract',
    description: 'Extract section references from contract text.',
    handlerKey: 'contract.references.extract',
    riskLevel: RiskLevel.LOW,
    autonomyLevel: AutonomyLevel.ALWAYS_ALLOWED,
    requiredPermissions: ['crm:quote:read'],
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        quoteId: { type: 'string' },
        text: { type: 'string' },
      },
    },
  },
  {
    name: 'contract.clause.createDraft',
    description: 'Create governed contract clause draft by stableId/version.',
    handlerKey: 'contract.clause.createDraft',
    riskLevel: RiskLevel.MEDIUM,
    autonomyLevel: AutonomyLevel.ALWAYS_ALLOWED,
    requiredPermissions: ['contract:write'],
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        stableId: { type: 'string' },
        version: { type: 'integer', minimum: 1 },
        jurisdiction: { type: 'string' },
        title: { type: 'string' },
        bodyText: { type: 'string' },
        metadata: { type: 'object' },
        requestId: { type: 'string' },
      },
      required: ['stableId', 'version', 'jurisdiction', 'title', 'bodyText'],
    },
  },
  {
    name: 'contract.clause.updateDraft',
    description: 'Update governed contract clause draft by stableId/version.',
    handlerKey: 'contract.clause.updateDraft',
    riskLevel: RiskLevel.MEDIUM,
    autonomyLevel: AutonomyLevel.ALWAYS_ALLOWED,
    requiredPermissions: ['contract:write'],
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        stableId: { type: 'string' },
        version: { type: 'integer', minimum: 1 },
        title: { type: 'string' },
        bodyText: { type: 'string' },
        metadata: { type: 'object' },
        requestId: { type: 'string' },
      },
      required: ['stableId', 'version'],
    },
  },
  {
    name: 'contract.clause.publish',
    description: 'Publish governed contract clause draft by stableId/version.',
    handlerKey: 'contract.clause.publish',
    riskLevel: RiskLevel.HIGH,
    autonomyLevel: AutonomyLevel.REQUIRES_APPROVAL,
    requiredPermissions: ['contract:publish'],
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        stableId: { type: 'string' },
        version: { type: 'integer', minimum: 1 },
        requestId: { type: 'string' },
      },
      required: ['stableId', 'version'],
    },
  },
  {
    name: 'contract.clause.deprecate',
    description: 'Deprecate governed contract clause version.',
    handlerKey: 'contract.clause.deprecate',
    riskLevel: RiskLevel.MEDIUM,
    autonomyLevel: AutonomyLevel.REQUIRES_APPROVAL,
    requiredPermissions: ['contract:publish'],
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        stableId: { type: 'string' },
        version: { type: 'integer', minimum: 1 },
        requestId: { type: 'string' },
        reason: { type: 'string' },
      },
      required: ['stableId', 'version'],
    },
  },
  {
    name: 'contract.template.createDraft',
    description: 'Create governed contract template draft by stableId/version.',
    handlerKey: 'contract.template.createDraft',
    riskLevel: RiskLevel.MEDIUM,
    autonomyLevel: AutonomyLevel.ALWAYS_ALLOWED,
    requiredPermissions: ['contract:write'],
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        templateStableId: { type: 'string' },
        version: { type: 'integer', minimum: 1 },
        jurisdiction: { type: 'string' },
        name: { type: 'string' },
        bodyText: { type: 'string' },
        clauseStableIds: { type: 'array', items: { type: 'string' } },
        structureJson: { type: 'object' },
        metadata: { type: 'object' },
        requestId: { type: 'string' },
      },
      required: ['templateStableId', 'version', 'jurisdiction', 'name', 'structureJson'],
    },
  },
  {
    name: 'contract.template.updateStructure',
    description: 'Update governed contract template structure.',
    handlerKey: 'contract.template.updateStructure',
    riskLevel: RiskLevel.MEDIUM,
    autonomyLevel: AutonomyLevel.ALWAYS_ALLOWED,
    requiredPermissions: ['contract:write'],
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        templateStableId: { type: 'string' },
        version: { type: 'integer', minimum: 1 },
        bodyText: { type: 'string' },
        clauseStableIds: { type: 'array', items: { type: 'string' } },
        structureJson: { type: 'object' },
        metadata: { type: 'object' },
        requestId: { type: 'string' },
      },
      required: ['templateStableId', 'version', 'structureJson'],
    },
  },
  {
    name: 'contract.template.updateVariableSchema',
    description: 'Update governed contract template variable schema.',
    handlerKey: 'contract.template.updateVariableSchema',
    riskLevel: RiskLevel.MEDIUM,
    autonomyLevel: AutonomyLevel.ALWAYS_ALLOWED,
    requiredPermissions: ['contract:write'],
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        templateStableId: { type: 'string' },
        version: { type: 'integer', minimum: 1 },
        variableSchemaJson: { type: 'object' },
        requestId: { type: 'string' },
      },
      required: ['templateStableId', 'version', 'variableSchemaJson'],
    },
  },
  {
    name: 'contract.template.publish',
    description: 'Publish governed contract template draft.',
    handlerKey: 'contract.template.publish',
    riskLevel: RiskLevel.HIGH,
    autonomyLevel: AutonomyLevel.REQUIRES_APPROVAL,
    requiredPermissions: ['contract:publish'],
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        templateStableId: { type: 'string' },
        version: { type: 'integer', minimum: 1 },
        requestId: { type: 'string' },
      },
      required: ['templateStableId', 'version'],
    },
  },
  {
    name: 'contract.legalPack.upsert',
    description: 'Upsert legal pack metadata and template associations.',
    handlerKey: 'contract.legalPack.upsert',
    riskLevel: RiskLevel.MEDIUM,
    autonomyLevel: AutonomyLevel.ALWAYS_ALLOWED,
    requiredPermissions: ['integration:legalpack:import'],
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        packStableId: { type: 'string' },
        jurisdiction: { type: 'string' },
        version: { type: 'string' },
        sourceRepo: { type: 'string' },
        sourceTag: { type: 'string' },
        templateStableIds: { type: 'array', items: { type: 'string' } },
        legalPackJson: { type: 'object' },
        metadata: { type: 'object' },
        requestId: { type: 'string' },
      },
      required: ['packStableId', 'jurisdiction', 'version', 'templateStableIds', 'legalPackJson'],
    },
  },
  {
    name: 'crm.job.createFromQuote',
    description: 'Create or reuse a job linked to a quote and geotag it.',
    handlerKey: 'crm.job.createFromQuote',
    riskLevel: RiskLevel.MEDIUM,
    autonomyLevel: AutonomyLevel.ALWAYS_ALLOWED,
    requiredPermissions: ['jobs:write'],
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        quoteId: { type: 'string' },
        title: { type: 'string' },
        scheduledAt: { type: 'string' },
        addressLine1: { type: 'string' },
        city: { type: 'string' },
        state: { type: 'string' },
        postalCode: { type: 'string' },
      },
      required: ['quoteId'],
    },
  },
  {
    name: 'scheduling.settings.update',
    description: 'Update org scheduling capacities, throttle mode, and booking triggers.',
    handlerKey: 'scheduling.settings.update',
    riskLevel: RiskLevel.MEDIUM,
    autonomyLevel: AutonomyLevel.ALWAYS_ALLOWED,
    requiredPermissions: ['scheduling:write'],
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        timezone: { type: 'string' },
        defaultServiceCapacityPerBlock: { type: 'integer', minimum: 1 },
        defaultInstallCapacityPerBlock: { type: 'integer', minimum: 1 },
        throttleServiceCapacityPerBlock: { type: 'integer', minimum: 1 },
        throttleInstallCapacityPerBlock: { type: 'integer', minimum: 1 },
        throttleServiceEnabled: { type: 'boolean' },
        throttleInstallEnabled: { type: 'boolean' },
        serviceBookingAllowedAt: { type: 'string', enum: ['SENT', 'ACCEPTED'] },
        installBookingAllowedAt: { type: 'string', enum: ['SENT', 'ACCEPTED'] },
      },
    },
  },
  {
    name: 'scheduling.blocks.listAvailability',
    description: 'List block availability with remaining capacity for a date range.',
    handlerKey: 'scheduling.blocks.listAvailability',
    riskLevel: RiskLevel.LOW,
    autonomyLevel: AutonomyLevel.ALWAYS_ALLOWED,
    requiredPermissions: ['scheduling:read'],
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        type: { type: 'string', enum: ['SERVICE_ESTIMATE', 'INSTALL'] },
        startDate: { type: 'string' },
        endDate: { type: 'string' },
      },
      required: ['type', 'startDate', 'endDate'],
    },
  },
  {
    name: 'scheduling.appointment.bookFromToken',
    description: 'Book appointment from quote token with atomic capacity reservation.',
    handlerKey: 'scheduling.appointment.bookFromToken',
    riskLevel: RiskLevel.MEDIUM,
    autonomyLevel: AutonomyLevel.ALWAYS_ALLOWED,
    requiredPermissions: ['scheduling:write'],
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        quoteToken: { type: 'string' },
        date: { type: 'string' },
        timeBlockCode: {
          type: 'string',
          enum: ['BLOCK_0800_1000', 'BLOCK_1000_1200', 'BLOCK_1200_1400', 'BLOCK_1400_1600'],
        },
        type: { type: 'string', enum: ['SERVICE_ESTIMATE', 'INSTALL'] },
        notes: { type: 'string' },
      },
      required: ['quoteToken', 'date', 'timeBlockCode'],
    },
  },
  {
    name: 'scheduling.appointment.reschedule',
    description: 'Internal reschedule of existing appointment with reservation transfer.',
    handlerKey: 'scheduling.appointment.reschedule',
    riskLevel: RiskLevel.MEDIUM,
    autonomyLevel: AutonomyLevel.ALWAYS_ALLOWED,
    requiredPermissions: ['scheduling:write'],
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        appointmentId: { type: 'string' },
        date: { type: 'string' },
        timeBlockCode: {
          type: 'string',
          enum: ['BLOCK_0800_1000', 'BLOCK_1000_1200', 'BLOCK_1200_1400', 'BLOCK_1400_1600'],
        },
        notes: { type: 'string' },
      },
      required: ['appointmentId', 'date', 'timeBlockCode'],
    },
  },
  {
    name: 'scheduling.appointment.cancel',
    description: 'Internal cancel of appointment and capacity release.',
    handlerKey: 'scheduling.appointment.cancel',
    riskLevel: RiskLevel.MEDIUM,
    autonomyLevel: AutonomyLevel.ALWAYS_ALLOWED,
    requiredPermissions: ['scheduling:write'],
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        appointmentId: { type: 'string' },
        reason: { type: 'string' },
      },
      required: ['appointmentId'],
    },
  },
  {
    name: 'scheduling.appointment.listForDay',
    description: 'List appointments for a specific day grouped for dispatch.',
    handlerKey: 'scheduling.appointment.listForDay',
    riskLevel: RiskLevel.LOW,
    autonomyLevel: AutonomyLevel.ALWAYS_ALLOWED,
    requiredPermissions: ['scheduling:read'],
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        date: { type: 'string' },
      },
      required: ['date'],
    },
  },
  {
    name: 'scheduling.appointment.assignTech',
    description: 'Assign a technician to an existing appointment.',
    handlerKey: 'scheduling.appointment.assignTech',
    riskLevel: RiskLevel.MEDIUM,
    autonomyLevel: AutonomyLevel.ALWAYS_ALLOWED,
    requiredPermissions: ['scheduling:write'],
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        appointmentId: { type: 'string' },
        techUserId: { type: 'string' },
      },
      required: ['appointmentId', 'techUserId'],
    },
  },
  {
    name: 'time.clockIn',
    description: 'Open shift entry for authenticated user if no shift is open.',
    handlerKey: 'time.clockIn',
    riskLevel: RiskLevel.LOW,
    autonomyLevel: AutonomyLevel.ALWAYS_ALLOWED,
    requiredPermissions: ['time:write'],
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        startedAtLocal: { type: 'string' },
        timezoneOffsetMinutes: { type: 'integer' },
        notes: { type: 'string' },
      },
    },
  },
  {
    name: 'time.clockOut',
    description: 'Close open shift entry and any open break/job entries for authenticated user.',
    handlerKey: 'time.clockOut',
    riskLevel: RiskLevel.LOW,
    autonomyLevel: AutonomyLevel.ALWAYS_ALLOWED,
    requiredPermissions: ['time:write'],
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        endedAtLocal: { type: 'string' },
        timezoneOffsetMinutes: { type: 'integer' },
        notes: { type: 'string' },
      },
    },
  },
  {
    name: 'time.breakStart',
    description: 'Start break entry for authenticated user.',
    handlerKey: 'time.breakStart',
    riskLevel: RiskLevel.LOW,
    autonomyLevel: AutonomyLevel.ALWAYS_ALLOWED,
    requiredPermissions: ['time:write'],
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        startedAtLocal: { type: 'string' },
        timezoneOffsetMinutes: { type: 'integer' },
        notes: { type: 'string' },
      },
    },
  },
  {
    name: 'time.breakEnd',
    description: 'End open break entry for authenticated user.',
    handlerKey: 'time.breakEnd',
    riskLevel: RiskLevel.LOW,
    autonomyLevel: AutonomyLevel.ALWAYS_ALLOWED,
    requiredPermissions: ['time:write'],
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        endedAtLocal: { type: 'string' },
        timezoneOffsetMinutes: { type: 'integer' },
        notes: { type: 'string' },
      },
    },
  },
  {
    name: 'time.jobStart',
    description: 'Start job timer for authenticated user.',
    handlerKey: 'time.jobStart',
    riskLevel: RiskLevel.LOW,
    autonomyLevel: AutonomyLevel.ALWAYS_ALLOWED,
    requiredPermissions: ['time:write'],
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        jobId: { type: 'string' },
        startedAtLocal: { type: 'string' },
        timezoneOffsetMinutes: { type: 'integer' },
        notes: { type: 'string' },
      },
      required: ['jobId'],
    },
  },
  {
    name: 'time.jobStop',
    description: 'Stop open job timer for authenticated user.',
    handlerKey: 'time.jobStop',
    riskLevel: RiskLevel.LOW,
    autonomyLevel: AutonomyLevel.ALWAYS_ALLOWED,
    requiredPermissions: ['time:write'],
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        jobId: { type: 'string' },
        endedAtLocal: { type: 'string' },
        timezoneOffsetMinutes: { type: 'integer' },
        notes: { type: 'string' },
      },
    },
  },
  {
    name: 'time.edit.request',
    description: 'Create pending time-entry edit request with reason.',
    handlerKey: 'time.edit.request',
    riskLevel: RiskLevel.MEDIUM,
    autonomyLevel: AutonomyLevel.ALWAYS_ALLOWED,
    requiredPermissions: ['time:edit:request'],
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        timeEntryId: { type: 'string' },
        requestedChanges: { type: 'object' },
        reason: { type: 'string' },
      },
      required: ['timeEntryId', 'requestedChanges', 'reason'],
    },
    requiresReason: true,
  },
  {
    name: 'time.edit.review',
    description: 'Approve or reject time-entry edit request and apply changes when approved.',
    handlerKey: 'time.edit.review',
    riskLevel: RiskLevel.HIGH,
    autonomyLevel: AutonomyLevel.ALWAYS_ALLOWED,
    requiredPermissions: ['time:edit:review'],
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        timeEditRequestId: { type: 'string' },
        decision: { type: 'string', enum: ['APPROVE', 'REJECT'] },
        reviewNote: { type: 'string' },
      },
      required: ['timeEditRequestId', 'decision'],
    },
    requiresReason: true,
  },
  {
    name: 'auth.mobile.pin.set',
    description: 'Set or replace a user mobile PIN and clear lock state.',
    handlerKey: 'auth.mobile.pin.set',
    riskLevel: RiskLevel.HIGH,
    autonomyLevel: AutonomyLevel.NEVER_AUTONOMOUS,
    requiredPermissions: ['auth:mobile:pin:set'],
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        userId: { type: 'string' },
        newPin: { type: 'string', pattern: '^\\d{4,6}$' },
      },
      required: ['userId', 'newPin'],
    },
    requiresReason: true,
    endpointAllowsHumanOverride: true,
  },
  {
    name: 'auth.mobile.pin.reset',
    description: 'Reset a user mobile PIN and force reset on next login.',
    handlerKey: 'auth.mobile.pin.reset',
    riskLevel: RiskLevel.HIGH,
    autonomyLevel: AutonomyLevel.NEVER_AUTONOMOUS,
    requiredPermissions: ['auth:mobile:pin:reset'],
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        userId: { type: 'string' },
        temporaryPin: { type: 'string', pattern: '^\\d{4,6}$' },
      },
      required: ['userId'],
    },
    requiresReason: true,
    endpointAllowsHumanOverride: true,
  },
  {
    name: 'auth.mobile.pin.login',
    description: 'Verify mobile PIN credentials and update login lockout counters.',
    handlerKey: 'auth.mobile.pin.login',
    riskLevel: RiskLevel.LOW,
    autonomyLevel: AutonomyLevel.ALWAYS_ALLOWED,
    requiredPermissions: [],
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        orgSlug: { type: 'string' },
        identifier: { type: 'string' },
        pin: { type: 'string', pattern: '^\\d{4,6}$' },
        deviceId: { type: 'string' },
        deviceName: { type: 'string' },
      },
      required: ['orgSlug', 'identifier', 'pin', 'deviceId'],
    },
  },
  {
    name: 'comms.imessage.sync',
    description: 'Sync iMessage history from local macOS chat.db into communications inbox.',
    handlerKey: 'comms.imessage.sync',
    riskLevel: RiskLevel.MEDIUM,
    autonomyLevel: AutonomyLevel.ALWAYS_ALLOWED,
    requiredPermissions: ['comms:sync'],
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        accountId: { type: 'string' },
        externalAccountId: { type: 'string' },
        displayName: { type: 'string' },
        fullSync: { type: 'boolean' },
        batchSize: { type: 'integer', minimum: 1, maximum: 5000 },
        cursor: { type: 'object' },
      },
    },
    requiresReason: true,
  },
  {
    name: 'comms.gmail.sync',
    description: 'Sync Gmail threads/messages into communications inbox.',
    handlerKey: 'comms.gmail.sync',
    riskLevel: RiskLevel.MEDIUM,
    autonomyLevel: AutonomyLevel.ALWAYS_ALLOWED,
    requiredPermissions: ['comms:sync'],
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        accountId: { type: 'string' },
        externalAccountId: { type: 'string' },
        displayName: { type: 'string' },
        fullSync: { type: 'boolean' },
        batchSize: { type: 'integer', minimum: 1, maximum: 5000 },
        cursor: { type: 'object' },
      },
    },
    requiresReason: true,
  },
  {
    name: 'comms.thread.link',
    description: 'Deterministically link a communications thread to CRM entities.',
    handlerKey: 'comms.thread.link',
    riskLevel: RiskLevel.LOW,
    autonomyLevel: AutonomyLevel.ALWAYS_ALLOWED,
    requiredPermissions: ['comms:triage'],
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        threadId: { type: 'string' },
        entityType: { type: 'string', enum: ['CUSTOMER', 'LEAD', 'JOB', 'QUOTE'] },
        entityId: { type: 'string' },
        confidence: { type: 'number', minimum: 0, maximum: 1 },
        reason: { type: 'string' },
      },
      required: ['threadId'],
    },
  },
  {
    name: 'comms.draft.create',
    description: 'Create outbound communication draft for inbox thread.',
    handlerKey: 'comms.draft.create',
    riskLevel: RiskLevel.MEDIUM,
    autonomyLevel: AutonomyLevel.ALWAYS_ALLOWED,
    requiredPermissions: ['comms:write'],
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        threadId: { type: 'string' },
        channel: { type: 'string', enum: ['IMESSAGE', 'SMS', 'EMAIL'] },
        to: { type: 'array', items: { type: 'object' }, minItems: 1 },
        subject: { type: 'string' },
        bodyText: { type: 'string' },
        bodyHtml: { type: 'string' },
      },
      required: ['threadId', 'channel', 'to', 'bodyText'],
    },
    requiresSnapshot: true,
  },
  {
    name: 'comms.draft.update',
    description: 'Update an existing outbound communication draft.',
    handlerKey: 'comms.draft.update',
    riskLevel: RiskLevel.MEDIUM,
    autonomyLevel: AutonomyLevel.ALWAYS_ALLOWED,
    requiredPermissions: ['comms:write'],
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        draftId: { type: 'string' },
        subject: { type: 'string' },
        bodyText: { type: 'string' },
        bodyHtml: { type: 'string' },
      },
      required: ['draftId', 'bodyText'],
    },
  },
  {
    name: 'comms.draft.approveAndSend',
    description: 'Queue approval and send outbound communication draft after approval.',
    handlerKey: 'comms.draft.approveAndSend',
    riskLevel: RiskLevel.HIGH,
    autonomyLevel: AutonomyLevel.NEVER_AUTONOMOUS,
    requiredPermissions: ['comms:send'],
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        draftId: { type: 'string' },
      },
      required: ['draftId'],
    },
    requiresReason: true,
    endpointAllowsHumanOverride: true,
  },
  {
    name: 'comms.message.markTriaged',
    description: 'Mark inbound communications message as triaged by operator/agent.',
    handlerKey: 'comms.message.markTriaged',
    riskLevel: RiskLevel.LOW,
    autonomyLevel: AutonomyLevel.ALWAYS_ALLOWED,
    requiredPermissions: ['comms:triage'],
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        messageId: { type: 'string' },
      },
      required: ['messageId'],
    },
  },
  {
    name: 'media.uploadSession.start',
    description: 'Start or resume an idempotent media upload session for quote/job photos.',
    handlerKey: 'media.uploadSession.start',
    riskLevel: RiskLevel.LOW,
    autonomyLevel: AutonomyLevel.ALWAYS_ALLOWED,
    requiredPermissions: ['media:write'],
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        sessionKey: { type: 'string' },
        ownerType: { type: 'string', enum: ['QUOTE', 'JOB'] },
        ownerId: { type: 'string' },
        tag: { type: 'string', enum: ['BEFORE', 'AFTER', 'EQUIPMENT_PLATE', 'RECEIPT', 'PROBLEM', 'INSTALL', 'OTHER'] },
        caption: { type: 'string' },
        fileName: { type: 'string' },
        mimeType: { type: 'string' },
        sizeBytes: { type: 'integer' },
        checksumSha256: { type: 'string' },
        metadata: { type: 'object' },
      },
      required: ['sessionKey', 'ownerType', 'ownerId', 'fileName', 'mimeType'],
    },
  },
  {
    name: 'media.uploadSession.complete',
    description: 'Finalize an idempotent media upload session with stored derivative object keys.',
    handlerKey: 'media.uploadSession.complete',
    riskLevel: RiskLevel.LOW,
    autonomyLevel: AutonomyLevel.ALWAYS_ALLOWED,
    requiredPermissions: ['media:write'],
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        sessionKey: { type: 'string' },
        attachmentId: { type: 'string' },
        bucket: { type: 'string' },
        objectKey: { type: 'string' },
        displayObjectKey: { type: 'string' },
        thumbObjectKey: { type: 'string' },
        fileName: { type: 'string' },
        mimeType: { type: 'string' },
        sizeBytes: { type: 'integer' },
        checksumSha256: { type: 'string' },
        width: { type: 'integer' },
        height: { type: 'integer' },
      },
      required: ['sessionKey', 'bucket', 'objectKey', 'displayObjectKey', 'thumbObjectKey', 'fileName', 'mimeType', 'sizeBytes', 'checksumSha256'],
    },
  },
  {
    name: 'media.uploadSession.fail',
    description: 'Record an upload session failure for retry and diagnostics.',
    handlerKey: 'media.uploadSession.fail',
    riskLevel: RiskLevel.LOW,
    autonomyLevel: AutonomyLevel.ALWAYS_ALLOWED,
    requiredPermissions: ['media:write'],
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        sessionKey: { type: 'string' },
        errorMessage: { type: 'string' },
      },
      required: ['sessionKey', 'errorMessage'],
    },
  },
  {
    name: 'media.photo.upload',
    description: 'Create an auditable media record for uploaded quote/job photos.',
    handlerKey: 'media.photo.upload',
    riskLevel: RiskLevel.MEDIUM,
    autonomyLevel: AutonomyLevel.ALWAYS_ALLOWED,
    requiredPermissions: ['media:write'],
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        attachmentId: { type: 'string' },
        ownerType: { type: 'string', enum: ['QUOTE', 'JOB'] },
        ownerId: { type: 'string' },
        tag: { type: 'string', enum: ['BEFORE', 'AFTER', 'EQUIPMENT_PLATE', 'RECEIPT', 'PROBLEM', 'INSTALL', 'OTHER'] },
        caption: { type: 'string' },
        kind: { type: 'string', enum: ['QUOTE_PHOTO', 'JOB_PHOTO'] },
        fileName: { type: 'string' },
        bucket: { type: 'string' },
        objectKey: { type: 'string' },
        displayObjectKey: { type: 'string' },
        thumbObjectKey: { type: 'string' },
        mimeType: { type: 'string' },
        sizeBytes: { type: 'integer' },
        checksumSha256: { type: 'string' },
        width: { type: 'integer' },
        height: { type: 'integer' },
      },
      required: ['attachmentId', 'ownerType', 'ownerId', 'tag', 'kind', 'fileName', 'bucket', 'objectKey', 'displayObjectKey', 'thumbObjectKey', 'mimeType', 'sizeBytes', 'checksumSha256'],
    },
  },
  {
    name: 'media.list',
    description: 'List quote/job photos for internal UI workflows.',
    handlerKey: 'media.list',
    riskLevel: RiskLevel.LOW,
    autonomyLevel: AutonomyLevel.ALWAYS_ALLOWED,
    requiredPermissions: ['media:read'],
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        ownerType: { type: 'string', enum: ['QUOTE', 'JOB'] },
        ownerId: { type: 'string' },
        includeDeleted: { type: 'boolean' },
      },
      required: ['ownerType', 'ownerId'],
    },
  },
  {
    name: 'media.setPublic',
    description: 'Toggle selective public sharing for quote photos.',
    handlerKey: 'media.setPublic',
    riskLevel: RiskLevel.MEDIUM,
    autonomyLevel: AutonomyLevel.ALWAYS_ALLOWED,
    requiredPermissions: ['media:share'],
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        attachmentId: { type: 'string' },
        isPublic: { type: 'boolean' },
      },
      required: ['attachmentId', 'isPublic'],
    },
  },
  {
    name: 'media.delete',
    description: 'Soft delete a media record and remove derivative objects from storage.',
    handlerKey: 'media.delete',
    riskLevel: RiskLevel.MEDIUM,
    autonomyLevel: AutonomyLevel.ALWAYS_ALLOWED,
    requiredPermissions: ['media:write'],
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        attachmentId: { type: 'string' },
        reason: { type: 'string' },
      },
      required: ['attachmentId'],
    },
    requiresReason: true,
  },
  {
    name: 'admin.media.purgeExpired',
    description: 'Purge expired media objects based on retention policy.',
    handlerKey: 'admin.media.purgeExpired',
    riskLevel: RiskLevel.HIGH,
    autonomyLevel: AutonomyLevel.ALWAYS_ALLOWED,
    requiredPermissions: ['media:purge'],
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        limit: { type: 'integer', minimum: 1, maximum: 1000 },
      },
    },
  },
  {
    name: 'marketing.sms.send',
    description: 'Send SMS to customer.',
    handlerKey: 'marketing.sms.send',
    riskLevel: RiskLevel.MEDIUM,
    autonomyLevel: AutonomyLevel.REQUIRES_APPROVAL,
    requiredPermissions: ['marketing:write'],
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        customerId: { type: 'string' },
        body: { type: 'string' },
      },
      required: ['customerId', 'body'],
    },
    cooldownSeconds: 30,
    maxCallsPerRun: 5,
    requiresSnapshot: true,
  },
  {
    name: 'marketing.email.send',
    description: 'Send email to customer.',
    handlerKey: 'marketing.email.send',
    riskLevel: RiskLevel.MEDIUM,
    autonomyLevel: AutonomyLevel.REQUIRES_APPROVAL,
    requiredPermissions: ['marketing:write'],
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        customerId: { type: 'string' },
        subject: { type: 'string' },
        body: { type: 'string' },
      },
      required: ['customerId', 'subject', 'body'],
    },
    cooldownSeconds: 30,
    maxCallsPerRun: 5,
    requiresSnapshot: true,
  },
  {
    name: 'marketing.review.request.draft',
    description: 'Draft a post-job review request message for customer follow-up.',
    handlerKey: 'marketing.review.request.draft',
    riskLevel: RiskLevel.MEDIUM,
    autonomyLevel: AutonomyLevel.ALWAYS_ALLOWED,
    requiredPermissions: ['marketing:reviews:write'],
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        jobId: { type: 'string' },
        customerId: { type: 'string' },
        channel: { type: 'string', enum: ['SMS', 'EMAIL'] },
        destination: { type: 'string' },
        messageDraft: { type: 'string' },
        reviewUrl: { type: 'string' },
        queueSend: { type: 'boolean' },
        providerMeta: { type: 'object' },
      },
    },
  },
  {
    name: 'marketing.review.request.send',
    description: 'Send a drafted review request through configured communications channel.',
    handlerKey: 'marketing.review.request.send',
    riskLevel: RiskLevel.HIGH,
    autonomyLevel: AutonomyLevel.REQUIRES_APPROVAL,
    requiredPermissions: ['marketing:reviews:write'],
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        reviewRequestId: { type: 'string' },
        provider: { type: 'string' },
      },
      required: ['reviewRequestId'],
    },
    requiresReason: true,
  },
  {
    name: 'marketing.review.request.auto',
    description: 'Draft review request automatically when a job is completed.',
    handlerKey: 'marketing.review.request.auto',
    riskLevel: RiskLevel.MEDIUM,
    autonomyLevel: AutonomyLevel.ALWAYS_ALLOWED,
    requiredPermissions: ['marketing:reviews:write'],
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        jobId: { type: 'string' },
        channel: { type: 'string', enum: ['SMS', 'EMAIL'] },
        destination: { type: 'string' },
        messageDraft: { type: 'string' },
        reviewUrl: { type: 'string' },
        queueSend: { type: 'boolean' },
        source: { type: 'string' },
      },
      required: ['jobId'],
    },
  },
  {
    name: 'marketing.referral.invite',
    description: 'Create referral invite event and generate referral code/link.',
    handlerKey: 'marketing.referral.invite',
    riskLevel: RiskLevel.MEDIUM,
    autonomyLevel: AutonomyLevel.ALWAYS_ALLOWED,
    requiredPermissions: ['marketing:referrals:write'],
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        customerId: { type: 'string' },
        programId: { type: 'string' },
        channel: { type: 'string', enum: ['SMS', 'EMAIL'] },
        destination: { type: 'string' },
        messageDraft: { type: 'string' },
        linkBaseUrl: { type: 'string' },
      },
      required: ['customerId'],
    },
  },
  {
    name: 'marketing.referral.convert',
    description: 'Link referred lead/customer to referral event and advance status.',
    handlerKey: 'marketing.referral.convert',
    riskLevel: RiskLevel.MEDIUM,
    autonomyLevel: AutonomyLevel.ALWAYS_ALLOWED,
    requiredPermissions: ['marketing:referrals:write'],
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        referralEventId: { type: 'string' },
        referredLeadId: { type: 'string' },
        referredCustomerId: { type: 'string' },
        status: { type: 'string', enum: ['INVITED', 'LEAD_CREATED', 'WON', 'REWARDED', 'VOID'] },
        notes: { type: 'string' },
      },
      required: ['referralEventId'],
    },
  },
  {
    name: 'marketing.referral.reward.issue',
    description: 'Issue referral reward credit/discount after verification.',
    handlerKey: 'marketing.referral.reward.issue',
    riskLevel: RiskLevel.HIGH,
    autonomyLevel: AutonomyLevel.REQUIRES_APPROVAL,
    requiredPermissions: ['marketing:referrals:write'],
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        referralEventId: { type: 'string' },
        rewardValueCents: { type: 'integer', minimum: 0 },
        memo: { type: 'string' },
      },
      required: ['referralEventId'],
    },
    requiresReason: true,
  },
  {
    name: 'billing.invoice.create',
    description: 'Create draft invoice.',
    handlerKey: 'billing.invoice.create',
    riskLevel: RiskLevel.HIGH,
    autonomyLevel: AutonomyLevel.REQUIRES_APPROVAL,
    requiredPermissions: ['billing:write'],
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        customerId: { type: 'string' },
        amountCents: { type: 'integer', minimum: 1 },
      },
      required: ['customerId', 'amountCents'],
    },
    requiresReason: true,
  },
  {
    name: 'billing.invoice.issue',
    description: 'Issue invoice to customer.',
    handlerKey: 'billing.invoice.issue',
    riskLevel: RiskLevel.HIGH,
    autonomyLevel: AutonomyLevel.REQUIRES_2ND_APPROVAL,
    requiredPermissions: ['billing:write'],
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        invoiceId: { type: 'string' },
      },
      required: ['invoiceId'],
    },
    requiresReason: true,
  },
  {
    name: 'crm.customer.upsertFromJobberCsv',
    description: 'Upsert customer record from Jobber CSV row.',
    handlerKey: 'crm.customer.upsertFromJobberCsv',
    riskLevel: RiskLevel.MEDIUM,
    autonomyLevel: AutonomyLevel.ALWAYS_ALLOWED,
    requiredPermissions: ['integration:jobber:import'],
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        sourceId: { type: 'string' },
        sourceType: { type: 'string' },
        fullName: { type: 'string' },
        email: { type: 'string' },
        phone: { type: 'string' },
        addressLine1: { type: 'string' },
        city: { type: 'string' },
        state: { type: 'string' },
        postalCode: { type: 'string' },
        rawRow: { type: 'object' },
        metadata: { type: 'object' },
        existingMbsId: { type: 'string' },
      },
      required: ['sourceId', 'sourceType', 'fullName'],
    },
  },
  {
    name: 'pricing.item.upsertFromJobberCsv',
    description: 'Upsert pricebook item from Jobber CSV row.',
    handlerKey: 'pricing.item.upsertFromJobberCsv',
    riskLevel: RiskLevel.MEDIUM,
    autonomyLevel: AutonomyLevel.ALWAYS_ALLOWED,
    requiredPermissions: ['integration:jobber:import'],
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        sourceId: { type: 'string' },
        sourceType: { type: 'string' },
        name: { type: 'string' },
        sku: { type: 'string' },
        description: { type: 'string' },
        unitPriceCents: { type: 'integer' },
        taxable: { type: 'boolean' },
        rawRow: { type: 'object' },
        metadata: { type: 'object' },
        existingMbsId: { type: 'string' },
      },
      required: ['sourceId', 'sourceType', 'name'],
    },
  },
  {
    name: 'crm.quote.importFromJobberCsv',
    description: 'Import quote record from Jobber CSV row.',
    handlerKey: 'crm.quote.importFromJobberCsv',
    riskLevel: RiskLevel.MEDIUM,
    autonomyLevel: AutonomyLevel.ALWAYS_ALLOWED,
    requiredPermissions: ['integration:jobber:import'],
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        sourceId: { type: 'string' },
        sourceType: { type: 'string' },
        quoteNumber: { type: 'string' },
        customerName: { type: 'string' },
        customerEmail: { type: 'string' },
        status: { type: 'string' },
        totalCents: { type: 'integer' },
        issuedAt: { type: 'string' },
        expiresAt: { type: 'string' },
        lineItems: { type: 'array' },
        lineItemsText: { type: 'string' },
        lineItemsParsed: { type: 'boolean' },
        rawRow: { type: 'object' },
        metadata: { type: 'object' },
        existingMbsId: { type: 'string' },
      },
      required: ['sourceId', 'sourceType'],
    },
  },
  {
    name: 'billing.invoice.importFromJobberCsv',
    description: 'Import invoice record from Jobber CSV row.',
    handlerKey: 'billing.invoice.importFromJobberCsv',
    riskLevel: RiskLevel.MEDIUM,
    autonomyLevel: AutonomyLevel.ALWAYS_ALLOWED,
    requiredPermissions: ['integration:jobber:import'],
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        sourceId: { type: 'string' },
        sourceType: { type: 'string' },
        invoiceNumber: { type: 'string' },
        customerName: { type: 'string' },
        customerEmail: { type: 'string' },
        status: { type: 'string' },
        totalCents: { type: 'integer' },
        balanceCents: { type: 'integer' },
        issuedAt: { type: 'string' },
        dueAt: { type: 'string' },
        lineItems: { type: 'array' },
        lineItemsText: { type: 'string' },
        lineItemsParsed: { type: 'boolean' },
        rawRow: { type: 'object' },
        metadata: { type: 'object' },
        existingMbsId: { type: 'string' },
      },
      required: ['sourceId', 'sourceType'],
    },
  },
  {
    name: 'catalog.equipment.importCsv',
    description: 'Import distributor CSV rows into equipment catalog source + entries.',
    handlerKey: 'catalog.equipment.importCsv',
    riskLevel: RiskLevel.MEDIUM,
    autonomyLevel: AutonomyLevel.ALWAYS_ALLOWED,
    requiredPermissions: ['catalog:equipment:write'],
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        sourceName: { type: 'string' },
        csvContent: { type: 'string' },
        attachmentRefId: { type: 'string' },
        mapping: {
          type: 'object',
          additionalProperties: false,
          properties: {
            skuColumn: { type: 'string' },
            manufacturerColumn: { type: 'string' },
            systemTypeColumn: { type: 'string' },
            textColumns: {
              type: 'array',
              items: { type: 'string' },
            },
          },
        },
        metadata: { type: 'object' },
      },
      required: ['sourceName', 'csvContent'],
    },
  },
  {
    name: 'catalog.equipment.lookup',
    description: 'Fuzzy lookup distributor catalog entries and decode hidden spec codes.',
    handlerKey: 'catalog.equipment.lookup',
    riskLevel: RiskLevel.LOW,
    autonomyLevel: AutonomyLevel.ALWAYS_ALLOWED,
    requiredPermissions: ['catalog:equipment:read'],
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        query: { type: 'string' },
        manufacturer: { type: 'string' },
        systemType: { type: 'string' },
        limit: { type: 'integer', minimum: 1, maximum: 25 },
      },
      required: ['query'],
    },
  },
  {
    name: 'catalog.equipment.options.generate',
    description: 'Generate Good/Better/Best equipment options from assessment sizing baseline.',
    handlerKey: 'catalog.equipment.options.generate',
    riskLevel: RiskLevel.LOW,
    autonomyLevel: AutonomyLevel.ALWAYS_ALLOWED,
    requiredPermissions: ['catalog:equipment:read'],
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        assessmentId: { type: 'string' },
        addOns: {
          type: 'array',
          items: { type: 'string' },
        },
      },
      required: ['assessmentId'],
    },
  },
  {
    name: 'crm.equipmentSpec.selectForAssessment',
    description: 'Persist selected equipment specs to SystemAssessment and create lookup run records.',
    handlerKey: 'crm.equipmentSpec.selectForAssessment',
    riskLevel: RiskLevel.MEDIUM,
    autonomyLevel: AutonomyLevel.ALWAYS_ALLOWED,
    requiredPermissions: ['crm:write'],
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        assessmentId: { type: 'string' },
        query: { type: 'string' },
        selected: { type: 'object' },
        selectedEntryId: { type: 'string' },
        selectedCandidateIndex: { type: 'integer', minimum: 0 },
        results: { type: 'array' },
      },
      required: ['assessmentId'],
    },
  },
  {
    name: 'crm.assessment.create',
    description: 'Create a system assessment record for install configuration workflows.',
    handlerKey: 'crm.assessment.create',
    riskLevel: RiskLevel.LOW,
    autonomyLevel: AutonomyLevel.ALWAYS_ALLOWED,
    requiredPermissions: ['crm:write'],
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        existingManufacturer: { type: 'string' },
        existingModel: { type: 'string' },
        existingSystemType: { type: 'string' },
        existingTonnage: { type: 'number' },
        existingFurnaceBtu: { type: 'integer' },
        existingSeer: { type: 'number' },
        existingAfue: { type: 'number' },
        metadata: { type: 'object' },
      },
    },
  },
  {
    name: 'crm.assessment.attachment.add',
    description: 'Attach a nameplate photo (attachment ref) to a system assessment.',
    handlerKey: 'crm.assessment.attachment.add',
    riskLevel: RiskLevel.LOW,
    autonomyLevel: AutonomyLevel.ALWAYS_ALLOWED,
    requiredPermissions: ['crm:attachment:write'],
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        assessmentId: { type: 'string' },
        attachmentRefId: { type: 'string' },
        kind: { type: 'string', enum: ['NAMEPLATE_PHOTO'] },
      },
      required: ['assessmentId', 'attachmentRefId'],
    },
  },
  {
    name: 'crm.assessment.update',
    description: 'Update assessment sizing/verification details for install decision flow.',
    handlerKey: 'crm.assessment.update',
    riskLevel: RiskLevel.MEDIUM,
    autonomyLevel: AutonomyLevel.ALWAYS_ALLOWED,
    requiredPermissions: ['crm:write'],
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        assessmentId: { type: 'string' },
        existingManufacturer: { type: 'string' },
        existingModel: { type: 'string' },
        existingSystemType: { type: 'string' },
        existingTonnage: { type: 'number' },
        existingFurnaceBtu: { type: 'integer' },
        existingSeer: { type: 'number' },
        existingAfue: { type: 'number' },
        verifiedBySupplyHouse: { type: 'boolean' },
        supplyHouseNotes: { type: 'string' },
        metadata: { type: 'object' },
      },
      required: ['assessmentId'],
    },
  },
  {
    name: 'crm.assessment.updateInstallPricingInputs',
    description: 'Update install pricing inputs on a system assessment.',
    handlerKey: 'crm.assessment.updateInstallPricingInputs',
    riskLevel: RiskLevel.MEDIUM,
    autonomyLevel: AutonomyLevel.ALWAYS_ALLOWED,
    requiredPermissions: ['crm:write'],
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        assessmentId: { type: 'string' },
        installType: { type: 'string', enum: ['COMBO', 'FURNACE_ONLY', 'AC_ONLY'] },
        accessType: {
          type: 'string',
          enum: ['STANDARD', 'ATTIC', 'CONFINED_CRAWLSPACE'],
        },
        baseLaborCostCents: { type: 'integer', minimum: 0 },
        manualLaborAdjustmentCents: { type: 'integer' },
        manualLaborReason: { type: 'string' },
        permitCostCents: { type: 'integer', minimum: 0 },
      },
      required: [
        'assessmentId',
        'installType',
        'accessType',
        'baseLaborCostCents',
        'manualLaborAdjustmentCents',
      ],
    },
    requiresReason: true,
  },
  {
    name: 'crm.quote.generateInstallOptions',
    description: 'Generate Good/Better/Best install quote options with finalized pricing breakdown.',
    handlerKey: 'crm.quote.generateInstallOptions',
    riskLevel: RiskLevel.MEDIUM,
    autonomyLevel: AutonomyLevel.ALWAYS_ALLOWED,
    requiredPermissions: ['crm:write'],
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        leadId: { type: 'string' },
        assessmentId: { type: 'string' },
        tierSelections: {
          type: 'object',
          additionalProperties: false,
          properties: {
            GOOD: { type: 'object' },
            BETTER: { type: 'object' },
            BEST: { type: 'object' },
          },
          required: ['GOOD', 'BETTER', 'BEST'],
        },
      },
      required: ['leadId', 'assessmentId', 'tierSelections'],
    },
    requiresReason: true,
  },
  {
    name: 'crm.quote.applyDiscount',
    description: 'Apply percentage and/or fixed discount to an install quote option.',
    handlerKey: 'crm.quote.applyDiscount',
    riskLevel: RiskLevel.MEDIUM,
    autonomyLevel: AutonomyLevel.ALWAYS_ALLOWED,
    requiredPermissions: ['crm:write'],
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        quoteOptionId: { type: 'string' },
        discountPctBps: { type: 'integer', minimum: 0, maximum: 10000 },
        discountCents: { type: 'integer', minimum: 0 },
        reason: { type: 'string' },
      },
      required: ['quoteOptionId'],
    },
    requiresReason: true,
  },
  {
    name: 'system.pricing.overrideBlock',
    description: 'Owner-only explicit override for blocked install quote options or service quotes.',
    handlerKey: 'system.pricing.overrideBlock',
    riskLevel: RiskLevel.HIGH,
    autonomyLevel: AutonomyLevel.NEVER_AUTONOMOUS,
    requiredPermissions: ['pricing:block:override'],
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        quoteId: { type: 'string' },
        quoteOptionId: { type: 'string' },
        reason: { type: 'string' },
      },
      anyOf: [{ required: ['quoteId'] }, { required: ['quoteOptionId'] }],
      required: ['reason'],
    },
    requiresReason: true,
    endpointAllowsHumanOverride: true,
  },
  {
    name: 'crm.serviceQuote.createFromBundle',
    description: 'Create a service quote from a bundle template with membership and labor snapshots.',
    handlerKey: 'crm.serviceQuote.createFromBundle',
    riskLevel: RiskLevel.MEDIUM,
    autonomyLevel: AutonomyLevel.ALWAYS_ALLOWED,
    requiredPermissions: ['crm:service_quote:write'],
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        leadId: { type: 'string' },
        customerId: { type: 'string' },
        bundleTemplateId: { type: 'string' },
        timing: { type: 'string', enum: ['NORMAL', 'AFTER_HOURS'] },
      },
      required: ['leadId', 'bundleTemplateId', 'timing'],
    },
    requiresReason: true,
  },
  {
    name: 'crm.serviceQuote.addLineItem',
    description: 'Add a pricebook or custom line item to a service quote and recompute totals.',
    handlerKey: 'crm.serviceQuote.addLineItem',
    riskLevel: RiskLevel.MEDIUM,
    autonomyLevel: AutonomyLevel.ALWAYS_ALLOWED,
    requiredPermissions: ['crm:service_quote:write'],
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        quoteId: { type: 'string' },
        pricebookItemId: { type: 'string' },
        custom: { type: 'object' },
        qty: { type: 'integer', minimum: 1 },
        sortOrder: { type: 'integer' },
      },
      required: ['quoteId'],
    },
    requiresReason: true,
  },
  {
    name: 'crm.serviceQuote.removeLineItem',
    description: 'Remove line item from service quote and recompute totals/credit.',
    handlerKey: 'crm.serviceQuote.removeLineItem',
    riskLevel: RiskLevel.MEDIUM,
    autonomyLevel: AutonomyLevel.ALWAYS_ALLOWED,
    requiredPermissions: ['crm:service_quote:write'],
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        quoteLineItemId: { type: 'string' },
      },
      required: ['quoteLineItemId'],
    },
    requiresReason: true,
  },
  {
    name: 'crm.serviceQuote.setLaborHours',
    description: 'Set service quote labor hours and recompute rounded labor totals.',
    handlerKey: 'crm.serviceQuote.setLaborHours',
    riskLevel: RiskLevel.MEDIUM,
    autonomyLevel: AutonomyLevel.ALWAYS_ALLOWED,
    requiredPermissions: ['crm:service_quote:write'],
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        quoteId: { type: 'string' },
        laborHours: { type: 'number', minimum: 0 },
      },
      required: ['quoteId', 'laborHours'],
    },
    requiresReason: true,
  },
  {
    name: 'crm.serviceQuote.setTiming',
    description: 'Set service quote timing (normal/after-hours) and recompute labor rate.',
    handlerKey: 'crm.serviceQuote.setTiming',
    riskLevel: RiskLevel.MEDIUM,
    autonomyLevel: AutonomyLevel.ALWAYS_ALLOWED,
    requiredPermissions: ['crm:service_quote:write'],
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        quoteId: { type: 'string' },
        timing: { type: 'string', enum: ['NORMAL', 'AFTER_HOURS'] },
      },
      required: ['quoteId', 'timing'],
    },
    requiresReason: true,
  },
  {
    name: 'crm.serviceQuote.applyDiscount',
    description: 'Apply percent and/or fixed discount to service quote subject to role limits and floors.',
    handlerKey: 'crm.serviceQuote.applyDiscount',
    riskLevel: RiskLevel.MEDIUM,
    autonomyLevel: AutonomyLevel.ALWAYS_ALLOWED,
    requiredPermissions: ['crm:service_quote:write'],
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        quoteId: { type: 'string' },
        discountPctBps: { type: 'integer', minimum: 0, maximum: 10000 },
        discountCents: { type: 'integer', minimum: 0 },
        reason: { type: 'string' },
      },
      required: ['quoteId'],
    },
    requiresReason: true,
  },
  {
    name: 'admin.bundleTemplates.upsert',
    description: 'Create or update service bundle templates.',
    handlerKey: 'admin.bundleTemplates.upsert',
    riskLevel: RiskLevel.MEDIUM,
    autonomyLevel: AutonomyLevel.ALWAYS_ALLOWED,
    requiredPermissions: ['bundles:manage'],
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        id: { type: 'string' },
        name: { type: 'string' },
        active: { type: 'boolean' },
        includeDiagnostic: { type: 'boolean' },
        defaultLaborHours: { type: 'number', minimum: 0 },
        baseItemIds: { type: 'array', items: { type: 'string' } },
        recommendedAddOnItemIds: { type: 'array', items: { type: 'string' } },
      },
      required: ['name'],
    },
    requiresReason: true,
  },
  {
    name: 'admin.pricebook.upsertCategory',
    description: 'Create or update pricebook category.',
    handlerKey: 'admin.pricebook.upsertCategory',
    riskLevel: RiskLevel.MEDIUM,
    autonomyLevel: AutonomyLevel.ALWAYS_ALLOWED,
    requiredPermissions: ['pricebook:manage'],
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        id: { type: 'string' },
        name: { type: 'string' },
        slug: { type: 'string' },
      },
      required: ['name', 'slug'],
    },
    requiresReason: true,
  },
  {
    name: 'admin.pricebook.upsertItem',
    description: 'Create or update pricebook item.',
    handlerKey: 'admin.pricebook.upsertItem',
    riskLevel: RiskLevel.MEDIUM,
    autonomyLevel: AutonomyLevel.ALWAYS_ALLOWED,
    requiredPermissions: ['pricebook:manage'],
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        id: { type: 'string' },
        categoryId: { type: 'string' },
        kind: { type: 'string', enum: ['SERVICE', 'ADDON', 'FEE'] },
        name: { type: 'string' },
        description: { type: 'string' },
        unitType: { type: 'string' },
        defaultSellCents: { type: 'integer', minimum: 0 },
        active: { type: 'boolean' },
        tags: { type: 'array', items: { type: 'string' } },
      },
      required: ['categoryId', 'kind', 'name', 'defaultSellCents'],
    },
    requiresReason: true,
  },
  {
    name: 'marketing.attribution.capture',
    description: 'Capture UTM/click attribution for leads or customers.',
    handlerKey: 'marketing.attribution.capture',
    riskLevel: RiskLevel.LOW,
    autonomyLevel: AutonomyLevel.ALWAYS_ALLOWED,
    requiredPermissions: ['marketing:write'],
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        leadId: { type: 'string' },
        customerId: { type: 'string' },
        contactId: { type: 'string' },
        sourceType: { type: 'string', enum: ['WEB_FORM', 'CHAT', 'BOOKING', 'CALL', 'IMPORT'] },
        utmSource: { type: 'string' },
        utmMedium: { type: 'string' },
        utmCampaign: { type: 'string' },
        utmContent: { type: 'string' },
        utmTerm: { type: 'string' },
        gclid: { type: 'string' },
        gbraid: { type: 'string' },
        wbraid: { type: 'string' },
        fbclid: { type: 'string' },
        landingUrl: { type: 'string' },
        referrerUrl: { type: 'string' },
        userAgent: { type: 'string' },
        ipHash: { type: 'string' },
        capturedAt: { type: 'string' },
        metadata: { type: 'object' },
      },
    },
  },
  {
    name: 'marketing.call.ingest',
    description: 'Ingest canonical call event payload from webhook providers.',
    handlerKey: 'marketing.call.ingest',
    riskLevel: RiskLevel.MEDIUM,
    autonomyLevel: AutonomyLevel.ALWAYS_ALLOWED,
    requiredPermissions: ['marketing:write'],
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        provider: { type: 'string' },
        providerCallId: { type: 'string' },
        direction: { type: 'string', enum: ['INBOUND', 'OUTBOUND'] },
        fromNumber: { type: 'string' },
        toNumber: { type: 'string' },
        startedAt: { type: 'string' },
        endedAt: { type: 'string' },
        durationSeconds: { type: 'integer', minimum: 0 },
        answered: { type: 'boolean' },
        recordingUrl: { type: 'string' },
        transcriptionUrl: { type: 'string' },
        disposition: { type: 'string' },
        metadata: { type: 'object' },
        raw: {},
      },
      required: ['provider', 'direction', 'fromNumber', 'toNumber', 'startedAt', 'answered'],
    },
  },
  {
    name: 'accounting.receipt.upload',
    description: 'Create receipt attachment and expense draft from uploaded receipt.',
    handlerKey: 'accounting.receipt.upload',
    riskLevel: RiskLevel.LOW,
    autonomyLevel: AutonomyLevel.ALWAYS_ALLOWED,
    requiredPermissions: ['accounting:write'],
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        bucket: { type: 'string' },
        objectKey: { type: 'string' },
        fileName: { type: 'string' },
        mimeType: { type: 'string' },
        sizeBytes: { type: 'integer', minimum: 1 },
        checksumSha256: { type: 'string' },
        jobId: { type: 'string' },
        vendorName: { type: 'string' },
        totalCents: { type: 'integer', minimum: 0 },
        taxCents: { type: 'integer', minimum: 0 },
        currency: { type: 'string' },
        purchaseDate: { type: 'string' },
        incurredAt: { type: 'string' },
        notes: { type: 'string' },
        memo: { type: 'string' },
        categoryId: { type: 'string' },
        metadata: { type: 'object' },
      },
      required: ['bucket', 'objectKey', 'fileName', 'mimeType', 'sizeBytes', 'checksumSha256'],
    },
  },
  {
    name: 'accounting.receipt.ocr.request',
    description: 'Queue or request OCR extraction for a receipt attachment.',
    handlerKey: 'accounting.receipt.ocr.request',
    riskLevel: RiskLevel.LOW,
    autonomyLevel: AutonomyLevel.ALWAYS_ALLOWED,
    requiredPermissions: ['accounting:receipt:ocr'],
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        receiptId: { type: 'string' },
        provider: { type: 'string', enum: ['OPENAI_VISION', 'GOOGLE_VISION', 'TESSERACT'] },
      },
      required: ['receiptId'],
    },
  },
  {
    name: 'accounting.receipt.applyOcr',
    description: 'Apply OCR extraction result to receipt and linked expense draft.',
    handlerKey: 'accounting.receipt.applyOcr',
    riskLevel: RiskLevel.MEDIUM,
    autonomyLevel: AutonomyLevel.ALWAYS_ALLOWED,
    requiredPermissions: ['accounting:receipt:ocr'],
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        receiptId: { type: 'string' },
        provider: { type: 'string', enum: ['OPENAI_VISION', 'GOOGLE_VISION', 'TESSERACT'] },
        status: { type: 'string', enum: ['PENDING', 'COMPLETED', 'FAILED'] },
        extractedMerchant: { type: 'string' },
        extractedDate: { type: 'string' },
        extractedTotalCents: { type: 'integer' },
        extractedTaxCents: { type: 'integer' },
        extractedLineItems: {},
        confidence: { type: 'object' },
        confidenceThreshold: { type: 'number' },
        rawText: {},
        rawPayload: {},
        errorMessage: { type: 'string' },
      },
      required: ['receiptId', 'provider'],
    },
  },
  {
    name: 'accounting.expense.update',
    description: 'Update expense draft details.',
    handlerKey: 'accounting.expense.update',
    riskLevel: RiskLevel.MEDIUM,
    autonomyLevel: AutonomyLevel.ALWAYS_ALLOWED,
    requiredPermissions: ['accounting:write'],
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        expenseId: { type: 'string' },
        vendorId: { type: 'string' },
        vendorName: { type: 'string' },
        amountCents: { type: 'integer' },
        taxCents: { type: 'integer' },
        currency: { type: 'string' },
        categoryId: { type: 'string' },
        jobId: { type: 'string' },
        memo: { type: 'string' },
        incurredAt: { type: 'string' },
        metadata: { type: 'object' },
      },
      required: ['expenseId'],
    },
  },
  {
    name: 'accounting.expense.submit',
    description: 'Submit expense draft for review.',
    handlerKey: 'accounting.expense.submit',
    riskLevel: RiskLevel.MEDIUM,
    autonomyLevel: AutonomyLevel.ALWAYS_ALLOWED,
    requiredPermissions: ['accounting:write'],
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        expenseId: { type: 'string' },
        memo: { type: 'string' },
      },
      required: ['expenseId'],
    },
  },
  {
    name: 'accounting.expense.approve',
    description: 'Approve a submitted expense.',
    handlerKey: 'accounting.expense.approve',
    riskLevel: RiskLevel.HIGH,
    autonomyLevel: AutonomyLevel.REQUIRES_APPROVAL,
    requiredPermissions: ['accounting:write'],
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        expenseId: { type: 'string' },
      },
      required: ['expenseId'],
    },
    requiresReason: true,
  },
  {
    name: 'accounting.vendor.upsert',
    description: 'Create or update accounting vendor.',
    handlerKey: 'accounting.vendor.upsert',
    riskLevel: RiskLevel.MEDIUM,
    autonomyLevel: AutonomyLevel.ALWAYS_ALLOWED,
    requiredPermissions: ['accounting:write'],
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        name: { type: 'string' },
        defaultCategoryId: { type: 'string' },
        metadata: { type: 'object' },
      },
      required: ['name'],
    },
  },
  {
    name: 'accounting.category.list',
    description: 'List configured accounting expense categories.',
    handlerKey: 'accounting.category.list',
    riskLevel: RiskLevel.LOW,
    autonomyLevel: AutonomyLevel.ALWAYS_ALLOWED,
    requiredPermissions: ['accounting:read'],
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {},
    },
  },
  {
    name: 'billing.subscription.modify',
    description: 'Modify customer subscription plan.',
    handlerKey: 'billing.subscription.modify',
    riskLevel: RiskLevel.HIGH,
    autonomyLevel: AutonomyLevel.REQUIRES_2ND_APPROVAL,
    requiredPermissions: ['billing:write'],
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        customerId: { type: 'string' },
        planCode: { type: 'string' },
      },
      required: ['customerId', 'planCode'],
    },
    requiresReason: true,
  },
  {
    name: 'pricing.plan.change',
    description: 'Apply a global pricing adjustment.',
    handlerKey: 'pricing.plan.change',
    riskLevel: RiskLevel.HIGH,
    autonomyLevel: AutonomyLevel.REQUIRES_2ND_APPROVAL,
    requiredPermissions: ['billing:write'],
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        percentChange: { type: 'number' },
      },
      required: ['percentChange'],
    },
    requiresReason: true,
  },
  {
    name: 'contracts.price.change',
    description: 'Change contract pricing terms.',
    handlerKey: 'contracts.price.change',
    riskLevel: RiskLevel.HIGH,
    autonomyLevel: AutonomyLevel.REQUIRES_2ND_APPROVAL,
    requiredPermissions: ['billing:write'],
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        customerId: { type: 'string' },
        newAmountCents: { type: 'integer', minimum: 1 },
      },
      required: ['customerId', 'newAmountCents'],
    },
    requiresReason: true,
  },
  {
    name: 'crm.lead.convert',
    description: 'Convert lead into customer.',
    handlerKey: 'crm.lead.convert',
    riskLevel: RiskLevel.MEDIUM,
    autonomyLevel: AutonomyLevel.REQUIRES_APPROVAL,
    requiredPermissions: ['crm:write'],
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        leadId: { type: 'string' },
      },
      required: ['leadId'],
    },
  },
  {
    name: 'inventory.part.reserve',
    description: 'Reserve inventory for job.',
    handlerKey: 'inventory.part.reserve',
    riskLevel: RiskLevel.MEDIUM,
    autonomyLevel: AutonomyLevel.REQUIRES_APPROVAL,
    requiredPermissions: ['jobs:write'],
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        jobId: { type: 'string' },
        sku: { type: 'string' },
        quantity: { type: 'integer', minimum: 1 },
      },
      required: ['jobId', 'sku', 'quantity'],
    },
  },
  {
    name: 'reporting.export.csv',
    description: 'Export report to CSV.',
    handlerKey: 'reporting.export.csv',
    riskLevel: RiskLevel.LOW,
    autonomyLevel: AutonomyLevel.ALWAYS_ALLOWED,
    requiredPermissions: ['reporting:*'],
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        reportType: { type: 'string' },
      },
      required: ['reportType'],
    },
  },
  {
    name: 'billing.refund.issue',
    description: 'Issue payment refund.',
    handlerKey: 'billing.refund.issue',
    riskLevel: RiskLevel.CRITICAL,
    autonomyLevel: AutonomyLevel.NEVER_AUTONOMOUS,
    requiredPermissions: ['billing:*'],
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        invoiceId: { type: 'string' },
        amountCents: { type: 'integer', minimum: 1 },
      },
      required: ['invoiceId', 'amountCents'],
    },
    requiresReason: true,
    endpointAllowsHumanOverride: true,
  },
  {
    name: 'auth.role.assign',
    description: 'Assign role to user.',
    handlerKey: 'auth.role.assign',
    riskLevel: RiskLevel.CRITICAL,
    autonomyLevel: AutonomyLevel.NEVER_AUTONOMOUS,
    requiredPermissions: ['auth:*'],
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        userId: { type: 'string' },
        roleName: { type: 'string' },
      },
      required: ['userId', 'roleName'],
    },
    requiresReason: true,
    endpointAllowsHumanOverride: true,
  },
  {
    name: 'crm.customer.delete',
    description: 'Delete customer record.',
    handlerKey: 'crm.customer.delete',
    riskLevel: RiskLevel.CRITICAL,
    autonomyLevel: AutonomyLevel.NEVER_AUTONOMOUS,
    requiredPermissions: ['crm:*'],
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        customerId: { type: 'string' },
      },
      required: ['customerId'],
    },
    requiresReason: true,
  },
  {
    name: 'jobs.job.delete',
    description: 'Delete job record.',
    handlerKey: 'jobs.job.delete',
    riskLevel: RiskLevel.CRITICAL,
    autonomyLevel: AutonomyLevel.NEVER_AUTONOMOUS,
    requiredPermissions: ['jobs:*'],
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        jobId: { type: 'string' },
      },
      required: ['jobId'],
    },
    requiresReason: true,
  },
  {
    name: 'system.user.disable',
    description: 'Disable user account access.',
    handlerKey: 'system.user.disable',
    riskLevel: RiskLevel.CRITICAL,
    autonomyLevel: AutonomyLevel.NEVER_AUTONOMOUS,
    requiredPermissions: ['system:*'],
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        userId: { type: 'string' },
      },
      required: ['userId'],
    },
    requiresReason: true,
    endpointAllowsHumanOverride: true,
  },
  {
    name: 'system.killswitch.status',
    description: 'Read current kill switch mode.',
    handlerKey: 'system.killswitch.status',
    riskLevel: RiskLevel.LOW,
    autonomyLevel: AutonomyLevel.ALWAYS_ALLOWED,
    requiredPermissions: ['system:killswitch:read'],
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {},
    },
  },
  {
    name: 'system.killswitch.set',
    description: 'Set kill switch mode.',
    handlerKey: 'system.killswitch.set',
    riskLevel: RiskLevel.CRITICAL,
    autonomyLevel: AutonomyLevel.NEVER_AUTONOMOUS,
    requiredPermissions: ['system:killswitch:write'],
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        mode: { type: 'string', enum: ['NORMAL', 'AUTONOMY_OFF', 'FULL_STOP'] },
        reason: { type: 'string' },
      },
      required: ['mode'],
    },
    endpointAllowsHumanOverride: true,
  },
  {
    name: 'system.agent.run.start',
    description: 'Start a master-agent run for a goal.',
    handlerKey: 'system.agent.run.start',
    riskLevel: RiskLevel.MEDIUM,
    autonomyLevel: AutonomyLevel.ALWAYS_ALLOWED,
    requiredPermissions: ['reporting:*'],
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        goal: { type: 'string', minLength: 1 },
        mode: { type: 'string', enum: ['AUTO', 'SUPERVISED'] },
        context: { type: 'object' },
      },
      required: ['goal'],
    },
  },
  {
    name: 'system.agent.run.pause',
    description: 'Pause an active master-agent run.',
    handlerKey: 'system.agent.run.pause',
    riskLevel: RiskLevel.LOW,
    autonomyLevel: AutonomyLevel.ALWAYS_ALLOWED,
    requiredPermissions: ['reporting:*'],
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        agentRunId: { type: 'string' },
      },
    },
  },
  {
    name: 'system.agent.run.resume',
    description: 'Resume a paused master-agent run.',
    handlerKey: 'system.agent.run.resume',
    riskLevel: RiskLevel.LOW,
    autonomyLevel: AutonomyLevel.ALWAYS_ALLOWED,
    requiredPermissions: ['reporting:*'],
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        agentRunId: { type: 'string' },
      },
    },
  },
  {
    name: 'system.agent.run.cancel',
    description: 'Cancel an active master-agent run.',
    handlerKey: 'system.agent.run.cancel',
    riskLevel: RiskLevel.MEDIUM,
    autonomyLevel: AutonomyLevel.ALWAYS_ALLOWED,
    requiredPermissions: ['reporting:*'],
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        agentRunId: { type: 'string' },
      },
    },
    requiresReason: true,
  },
  {
    name: 'system.agent.run.suggest_skill',
    description: 'Store preferred next-skill steering hint for active run.',
    handlerKey: 'system.agent.run.suggest_skill',
    riskLevel: RiskLevel.LOW,
    autonomyLevel: AutonomyLevel.ALWAYS_ALLOWED,
    requiredPermissions: ['reporting:*'],
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        agentRunId: { type: 'string' },
        skillId: { type: 'string' },
      },
      required: ['agentRunId', 'skillId'],
    },
  },
  {
    name: 'crm.communication.log',
    description: 'Write communication log event.',
    handlerKey: 'crm.communication.log',
    riskLevel: RiskLevel.LOW,
    autonomyLevel: AutonomyLevel.ALWAYS_ALLOWED,
    requiredPermissions: ['crm:write'],
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        customerId: { type: 'string' },
        channel: { type: 'string' },
        detail: { type: 'string' },
      },
      required: ['customerId', 'channel', 'detail'],
    },
  },
  {
    name: 'crm.lead.tag.add',
    description: 'Add a tag to lead.',
    handlerKey: 'crm.lead.tag.add',
    riskLevel: RiskLevel.LOW,
    autonomyLevel: AutonomyLevel.ALWAYS_ALLOWED,
    requiredPermissions: ['crm:write'],
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        leadId: { type: 'string' },
        tag: { type: 'string' },
      },
      required: ['leadId', 'tag'],
    },
  },
  {
    name: 'jobs.note.add',
    description: 'Add note to job timeline.',
    handlerKey: 'jobs.note.add',
    riskLevel: RiskLevel.LOW,
    autonomyLevel: AutonomyLevel.ALWAYS_ALLOWED,
    requiredPermissions: ['jobs:write'],
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        jobId: { type: 'string' },
        note: { type: 'string' },
      },
      required: ['jobId', 'note'],
    },
  },
  {
    name: 'jobs.priority.update',
    description: 'Set job priority level.',
    handlerKey: 'jobs.priority.update',
    riskLevel: RiskLevel.MEDIUM,
    autonomyLevel: AutonomyLevel.REQUIRES_APPROVAL,
    requiredPermissions: ['jobs:write'],
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        jobId: { type: 'string' },
        priority: { type: 'string' },
      },
      required: ['jobId', 'priority'],
    },
  },
  {
    name: 'billing.payment.record',
    description: 'Record incoming customer payment.',
    handlerKey: 'billing.payment.record',
    riskLevel: RiskLevel.MEDIUM,
    autonomyLevel: AutonomyLevel.REQUIRES_APPROVAL,
    requiredPermissions: ['billing:write'],
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        invoiceId: { type: 'string' },
        amountCents: { type: 'integer', minimum: 1 },
      },
      required: ['invoiceId', 'amountCents'],
    },
  },
  {
    name: 'billing.adjustment.create',
    description: 'Create billing adjustment entry.',
    handlerKey: 'billing.adjustment.create',
    riskLevel: RiskLevel.HIGH,
    autonomyLevel: AutonomyLevel.REQUIRES_2ND_APPROVAL,
    requiredPermissions: ['billing:write'],
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        invoiceId: { type: 'string' },
        amountCents: { type: 'integer' },
        reason: { type: 'string' },
      },
      required: ['invoiceId', 'amountCents', 'reason'],
    },
    requiresReason: true,
  },
  {
    name: 'jobs.dispatch.cancel',
    description: 'Cancel a dispatch assignment.',
    handlerKey: 'jobs.dispatch.cancel',
    riskLevel: RiskLevel.MEDIUM,
    autonomyLevel: AutonomyLevel.REQUIRES_APPROVAL,
    requiredPermissions: ['jobs:write'],
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        jobId: { type: 'string' },
      },
      required: ['jobId'],
    },
    requiresReason: true,
  },
];

const defaultPolicyJsonV1 = {
  version: 1,
  autonomy: {
    enabled: true,
    defaultMode: 'SAFE',
    maxRiskLevelAutonomous: 'HIGH',
    toolBlocks: {
      deny: [
        'system.user.role.modify',
        'billing.refund.*',
        'system.delete.*',
      ],
      denyIfAutonomous: [
        'billing.invoice.issue',
        'marketing.sms.send',
        'comms.draft.approveAndSend',
      ],
      allowOnly: [],
    },
    timeWindows: [
      {
        name: 'business-hours',
        timezone: 'America/Denver',
        days: ['MON', 'TUE', 'WED', 'THU', 'FRI'],
        start: '09:00',
        end: '18:00',
        rules: {
          denyTools: ['marketing.sms.send', 'comms.draft.approveAndSend'],
          maxRiskLevelAutonomous: 'MEDIUM',
        },
      },
    ],
    rateLimits: {
      perRun: {
        maxToolCalls: 120,
        maxQueuedApprovals: 25,
        cooldownSecondsByRisk: {
          LOW: 0,
          MEDIUM: 5,
          HIGH: 30,
          CRITICAL: 999999,
        },
      },
      perTool: [
        { tool: 'marketing.sms.send', maxPerDay: 200, maxPerHour: 40 },
        { tool: 'billing.invoice.issue', maxPerDay: 20 },
        { tool: 'comms.draft.approveAndSend', maxPerDay: 25, maxPerHour: 10 },
      ],
    },
  },
  financial: {
    currency: 'USD',
    dailyExposure: {
      enabled: true,
      scope: 'ORG',
      resetsAt: '00:00',
      timezone: 'America/Denver',
      limits: {
        invoiceIssueCents: 250000,
        subscriptionCreateCents: 150000,
        discountTotalCents: 50000,
      },
      toolCostMap: [
        { tool: 'billing.invoice.issue', amountField: 'totalCents', bucket: 'invoiceIssueCents' },
        { tool: 'billing.subscription.create', amountField: 'amountCents', bucket: 'subscriptionCreateCents' },
        { tool: 'pricing.discount.apply', amountField: 'discountCents', bucket: 'discountTotalCents' },
        { tool: 'crm.quote.applyDiscount', amountField: 'discountTotalCents', bucket: 'discountTotalCents' },
      ],
      onBreach: {
        mode: 'QUEUE_APPROVAL',
        requireApprovals: 2,
        note: 'Daily financial exposure exceeded',
      },
    },
  },
  approvals: {
    defaults: {
      MEDIUM: { requiredApprovals: 1, expiresMinutes: 120 },
      HIGH: { requiredApprovals: 2, expiresMinutes: 240 },
      CRITICAL: { requiredApprovals: 2, expiresMinutes: 60 },
    },
    escalation: {
      ifPendingMinutes: 60,
      notifyRoles: ['owner', 'dispatcher_manager'],
    },
  },
  killSwitch: {
    enabled: true,
    modes: {
      AUTONOMY_OFF: {
        blocksAutonomousExecution: true,
        stillAllowReadTools: true,
        stillAllowHumanExecution: true,
      },
      FULL_STOP: {
        blocksAutonomousExecution: true,
        stillAllowReadTools: false,
        stillAllowHumanExecution: true,
      },
    },
    currentMode: 'AUTONOMY_OFF',
  },
} as const satisfies Prisma.InputJsonValue;

async function seedRolesAndPermissions(orgId: string) {
  for (const permission of permissions) {
    await prisma.permission.upsert({
      where: { key: permission.key },
      update: permission,
      create: permission,
    });
  }

  const permissionMap = new Map(
    (await prisma.permission.findMany()).map((permission) => [permission.key, permission.id]),
  );

  for (const [roleName, permissionKeys] of Object.entries(roleDefinitions)) {
    const role = await prisma.role.upsert({
      where: {
        orgId_name: {
          orgId,
          name: roleName,
        },
      },
      update: {
        isSystem: true,
      },
      create: {
        orgId,
        name: roleName,
        description: `${roleName} system role`,
        isSystem: true,
      },
    });

    for (const key of permissionKeys) {
      const permissionId = permissionMap.get(key);
      if (!permissionId) {
        continue;
      }
      await prisma.rolePermission.upsert({
        where: {
          roleId_permissionId: {
            roleId: role.id,
            permissionId,
          },
        },
        update: {},
        create: {
          roleId: role.id,
          permissionId,
        },
      });
    }
  }
}

async function seedUsers(orgId: string) {
  const admin = await prisma.user.upsert({
    where: {
      orgId_email: {
        orgId,
        email: 'admin@russellcomfort.com',
      },
    },
    update: {
      name: 'Admin User',
      phone: '+17205551001',
      employeeCode: 'RCS-ADM-001',
      actorType: ActorType.HUMAN,
      isActive: true,
    },
    create: {
      orgId,
      email: 'admin@russellcomfort.com',
      name: 'Admin User',
      phone: '+17205551001',
      employeeCode: 'RCS-ADM-001',
      passwordHash: 'seed-placeholder-hash',
      actorType: ActorType.HUMAN,
      isActive: true,
    },
  });

  const approver = await prisma.user.upsert({
    where: {
      orgId_email: {
        orgId,
        email: 'manager@russellcomfort.com',
      },
    },
    update: {
      name: 'Approver Manager',
      phone: '+17205551002',
      employeeCode: 'RCS-MGR-001',
      actorType: ActorType.HUMAN,
      isActive: true,
    },
    create: {
      orgId,
      email: 'manager@russellcomfort.com',
      name: 'Approver Manager',
      phone: '+17205551002',
      employeeCode: 'RCS-MGR-001',
      passwordHash: 'seed-placeholder-hash',
      actorType: ActorType.HUMAN,
      isActive: true,
    },
  });

  const masterAgent = await prisma.user.upsert({
    where: {
      orgId_email: {
        orgId,
        email: 'master-agent@system.russellcomfort.local',
      },
    },
    update: {
      name: 'Master Agent',
      actorType: ActorType.SYSTEM,
      isActive: true,
    },
    create: {
      orgId,
      email: 'master-agent@system.russellcomfort.local',
      name: 'Master Agent',
      actorType: ActorType.SYSTEM,
      isActive: true,
    },
  });

  const salesRep = await prisma.user.upsert({
    where: {
      orgId_email: {
        orgId,
        email: 'sales@russellcomfort.com',
      },
    },
    update: {
      name: 'Sales Representative',
      phone: '+17205551003',
      employeeCode: 'RCS-SAL-001',
      actorType: ActorType.HUMAN,
      isActive: true,
    },
    create: {
      orgId,
      email: 'sales@russellcomfort.com',
      name: 'Sales Representative',
      phone: '+17205551003',
      employeeCode: 'RCS-SAL-001',
      passwordHash: 'seed-placeholder-hash',
      actorType: ActorType.HUMAN,
      isActive: true,
    },
  });

  const techUser = await prisma.user.upsert({
    where: {
      orgId_email: {
        orgId,
        email: 'tech@russellcomfort.com',
      },
    },
    update: {
      name: 'Field Technician',
      phone: '+17205551004',
      employeeCode: 'RCS-TEC-001',
      actorType: ActorType.HUMAN,
      isActive: true,
    },
    create: {
      orgId,
      email: 'tech@russellcomfort.com',
      name: 'Field Technician',
      phone: '+17205551004',
      employeeCode: 'RCS-TEC-001',
      passwordHash: 'seed-placeholder-hash',
      actorType: ActorType.HUMAN,
      isActive: true,
    },
  });

  const roles = await prisma.role.findMany({
    where: {
      orgId,
      name: { in: ['admin', 'billing_manager', 'sales_rep', 'master_agent', 'tech'] },
    },
  });

  const roleByName = new Map(roles.map((role) => [role.name, role.id]));

  const assignments = [
    { userId: admin.id, roleName: 'admin' },
    { userId: approver.id, roleName: 'billing_manager' },
    { userId: salesRep.id, roleName: 'sales_rep' },
    { userId: masterAgent.id, roleName: 'master_agent' },
    { userId: techUser.id, roleName: 'tech' },
  ];

  for (const assignment of assignments) {
    const roleId = roleByName.get(assignment.roleName);
    if (!roleId) {
      continue;
    }
    await prisma.userRole.upsert({
      where: {
        userId_roleId: {
          userId: assignment.userId,
          roleId,
        },
      },
      update: {},
      create: {
        userId: assignment.userId,
        roleId,
      },
    });
  }

  const demoPin = (process.env.SEED_DEMO_MOBILE_PIN ?? '').trim();
  if (/^\d{4,6}$/.test(demoPin)) {
    const pinHash = await bcrypt.hash(demoPin, 12);
    const now = new Date();
    await prisma.user.updateMany({
      where: {
        orgId,
        id: { in: [admin.id, approver.id, salesRep.id, techUser.id] },
      },
      data: {
        mobilePinHash: pinHash,
        mobilePinUpdatedAt: now,
        mobilePinFailedAttempts: 0,
        mobilePinLockedUntil: null,
        mobilePinResetRequired: false,
      },
    });
  }

  return { admin, approver, salesRep, masterAgent, techUser };
}

async function seedPolicy(orgId: string, createdByUserId: string) {
  return prisma.policy.upsert({
    where: {
      orgId_name_version: {
        orgId,
        name: 'default-autonomy-policy',
        version: 1,
      },
    },
    update: {
      isActive: true,
      policyJson: defaultPolicyJsonV1,
      createdByUserId,
    },
    create: {
      orgId,
      name: 'default-autonomy-policy',
      version: 1,
      isActive: true,
      policyJson: defaultPolicyJsonV1,
      createdByUserId,
    },
  });
}

async function seedOrgSafetyState(orgId: string, updatedByUserId: string) {
  return prisma.orgSafetyState.upsert({
    where: { orgId },
    update: {
      mode: SafetyMode.NORMAL,
      reason: 'Seed default',
      updatedByUserId,
    },
    create: {
      orgId,
      mode: SafetyMode.NORMAL,
      reason: 'Seed default',
      updatedByUserId,
    },
  });
}

async function seedTools(orgId: string) {
  for (const tool of toolCatalog) {
    await prisma.toolDefinition.upsert({
      where: {
        orgId_name_version: {
          orgId,
          name: tool.name,
          version: '1.0.0',
        },
      },
      update: {
        description: tool.description,
        handlerKey: tool.handlerKey,
        active: true,
        riskLevel: tool.riskLevel,
        autonomyLevel: tool.autonomyLevel,
        requiredPermissions: tool.requiredPermissions,
        inputSchema: tool.inputSchema as Prisma.InputJsonValue,
        cooldownSeconds: tool.cooldownSeconds,
        maxCallsPerRun: tool.maxCallsPerRun,
        requiresReason: tool.requiresReason ?? false,
        requiresSnapshot: tool.requiresSnapshot ?? false,
        endpointAllowsHumanOverride: tool.endpointAllowsHumanOverride ?? false,
      },
      create: {
        orgId,
        name: tool.name,
        version: '1.0.0',
        description: tool.description,
        handlerKey: tool.handlerKey,
        active: true,
        riskLevel: tool.riskLevel,
        autonomyLevel: tool.autonomyLevel,
        requiredPermissions: tool.requiredPermissions,
        inputSchema: tool.inputSchema as Prisma.InputJsonValue,
        cooldownSeconds: tool.cooldownSeconds,
        maxCallsPerRun: tool.maxCallsPerRun,
        requiresReason: tool.requiresReason ?? false,
        requiresSnapshot: tool.requiresSnapshot ?? false,
        endpointAllowsHumanOverride: tool.endpointAllowsHumanOverride ?? false,
      },
    });
  }
}

async function seedDomainData(orgId: string) {
  const customer = await prisma.customer.create({
    data: {
      orgId,
      fullName: 'Patricia Miller',
      email: 'patricia@example.com',
      phone: '555-0142',
      city: 'Denver',
      state: 'CO',
      postalCode: '80202',
    },
  });

  const lead = await prisma.lead.create({
    data: {
      orgId,
      fullName: 'Jordan Wilson',
      email: 'jordan@example.com',
      phone: '555-0155',
      status: 'NEW',
      score: 20,
    },
  });

  const invoice = await prisma.invoice.create({
    data: {
      orgId,
      customerId: customer.id,
      amountCents: 44900,
      status: 'DRAFT',
    },
  });

  await prisma.job.create({
    data: {
      orgId,
      customerId: customer.id,
      title: 'Seasonal HVAC tune-up',
      status: 'OPEN',
    },
  });

  return { customer, lead, invoice };
}

async function seedExpenseCatalog(orgId: string) {
  const categories = [
    { name: 'COGS - Parts', code: 'COGS_PARTS', isCogs: true, sortOrder: 10 },
    { name: 'Fuel', code: 'FUEL', isCogs: false, sortOrder: 20 },
    { name: 'Tools', code: 'TOOLS', isCogs: false, sortOrder: 30 },
    { name: 'Permits', code: 'PERMITS', isCogs: false, sortOrder: 40 },
  ];

  const created = new Map<string, string>();
  for (const category of categories) {
    const row = await prisma.expenseCategory.upsert({
      where: {
        orgId_name: {
          orgId,
          name: category.name,
        },
      },
      update: {
        code: category.code,
        isCogs: category.isCogs,
        sortOrder: category.sortOrder,
      },
      create: {
        orgId,
        ...category,
      },
    });
    created.set(row.name, row.id);
  }

  const partsCategoryId = created.get('COGS - Parts');
  if (partsCategoryId) {
    for (const vendorName of ['Johnstone Supply', 'Ferguson']) {
      await prisma.vendor.upsert({
        where: {
          orgId_name: {
            orgId,
            name: vendorName,
          },
        },
        update: {
          defaultCategoryId: partsCategoryId,
        },
        create: {
          orgId,
          name: vendorName,
          defaultCategoryId: partsCategoryId,
        },
      });
    }
  }
}

async function seedReferralProgram(orgId: string) {
  const existing = await prisma.referralProgram.findFirst({
    where: {
      orgId,
      name: 'Standard Referral',
    },
    orderBy: { createdAt: 'asc' },
    select: { id: true },
  });

  const payload = {
    orgId,
    name: 'Standard Referral',
    isActive: true,
    rewardType: 'CREDIT' as const,
    rewardValueCents: 2500,
    terms: {
      description: '$25 account credit after referred customer wins and pays first invoice.',
      eligibility: ['new customer only', 'one reward per referred household'],
    },
  };

  if (existing?.id) {
    await prisma.referralProgram.update({
      where: { id: existing.id },
      data: {
        isActive: payload.isActive,
        rewardType: payload.rewardType,
        rewardValueCents: payload.rewardValueCents,
        terms: payload.terms,
      },
    });
    return;
  }

  await prisma.referralProgram.create({
    data: payload,
  });
}

async function seedSchedulingDefaults(orgId: string) {
  await prisma.orgSchedulingSettings.upsert({
    where: { orgId },
    update: {
      timezone: 'America/Denver',
      defaultServiceCapacityPerBlock: 2,
      defaultInstallCapacityPerBlock: 2,
      throttleServiceCapacityPerBlock: 1,
      throttleInstallCapacityPerBlock: 1,
      throttleServiceEnabled: false,
      throttleInstallEnabled: false,
      serviceBookingAllowedAt: 'SENT',
      installBookingAllowedAt: 'ACCEPTED',
    },
    create: {
      orgId,
      timezone: 'America/Denver',
      defaultServiceCapacityPerBlock: 2,
      defaultInstallCapacityPerBlock: 2,
      throttleServiceCapacityPerBlock: 1,
      throttleInstallCapacityPerBlock: 1,
      throttleServiceEnabled: false,
      throttleInstallEnabled: false,
      serviceBookingAllowedAt: 'SENT',
      installBookingAllowedAt: 'ACCEPTED',
    },
  });

  const timeBlocks: Array<{ code: 'BLOCK_0800_1000' | 'BLOCK_1000_1200' | 'BLOCK_1200_1400' | 'BLOCK_1400_1600'; startTime: string; endTime: string }> = [
    { code: 'BLOCK_0800_1000', startTime: '08:00', endTime: '10:00' },
    { code: 'BLOCK_1000_1200', startTime: '10:00', endTime: '12:00' },
    { code: 'BLOCK_1200_1400', startTime: '12:00', endTime: '14:00' },
    { code: 'BLOCK_1400_1600', startTime: '14:00', endTime: '16:00' },
  ];

  for (const block of timeBlocks) {
    await prisma.timeBlockTemplate.upsert({
      where: {
        orgId_code: {
          orgId,
          code: block.code,
        },
      },
      update: {
        startTime: block.startTime,
        endTime: block.endTime,
        active: true,
      },
      create: {
        orgId,
        code: block.code,
        startTime: block.startTime,
        endTime: block.endTime,
        active: true,
      },
    });
  }

  const hours = [
    { dayOfWeek: 0, openTime: '00:00', closeTime: '00:00', isClosed: true },
    { dayOfWeek: 1, openTime: '08:00', closeTime: '16:00', isClosed: false },
    { dayOfWeek: 2, openTime: '08:00', closeTime: '16:00', isClosed: false },
    { dayOfWeek: 3, openTime: '08:00', closeTime: '16:00', isClosed: false },
    { dayOfWeek: 4, openTime: '08:00', closeTime: '16:00', isClosed: false },
    { dayOfWeek: 5, openTime: '08:00', closeTime: '16:00', isClosed: false },
    { dayOfWeek: 6, openTime: '00:00', closeTime: '00:00', isClosed: true },
  ];

  for (const row of hours) {
    await prisma.businessHours.upsert({
      where: {
        orgId_dayOfWeek: {
          orgId,
          dayOfWeek: row.dayOfWeek,
        },
      },
      update: {
        openTime: row.openTime,
        closeTime: row.closeTime,
        isClosed: row.isClosed,
      },
      create: {
        orgId,
        dayOfWeek: row.dayOfWeek,
        openTime: row.openTime,
        closeTime: row.closeTime,
        isClosed: row.isClosed,
      },
    });
  }
}

async function seedServicePricingCatalog(orgId: string) {
  const categories = [
    { name: 'Fees', slug: 'fees' },
    { name: 'Repair', slug: 'repair' },
    { name: 'Maintenance', slug: 'maintenance' },
    { name: 'Evaporative Cooler', slug: 'evaporative-cooler' },
    { name: 'IAQ & Add-Ons', slug: 'iaq-add-ons' },
  ];

  const categoryIdBySlug = new Map<string, string>();
  for (const category of categories) {
    const existing = await prisma.pricebookCategory.findFirst({
      where: {
        orgId,
        slug: category.slug,
      },
      orderBy: { createdAt: 'asc' },
    });
    const row = existing
      ? await prisma.pricebookCategory.update({
          where: { id: existing.id },
          data: {
            name: category.name,
            slug: category.slug,
          },
        })
      : await prisma.pricebookCategory.create({
          data: {
            orgId,
            name: category.name,
            slug: category.slug,
          },
        });
    categoryIdBySlug.set(category.slug, row.id);
  }

  const itemSeeds: Array<{
    key: string;
    name: string;
    categorySlug: string;
    kind: 'SERVICE' | 'ADDON' | 'FEE';
    defaultSellCents: number;
    description?: string;
    tags?: string[];
  }> = [
    {
      key: 'diagnostic_fee',
      name: 'Diagnostic Fee',
      categorySlug: 'fees',
      kind: 'FEE',
      defaultSellCents: 12900,
      description: 'Standard diagnostic dispatch and troubleshooting fee.',
      tags: ['diagnostic'],
    },
    {
      key: 'repair_capacitor',
      name: 'Capacitor Replacement',
      categorySlug: 'repair',
      kind: 'SERVICE',
      defaultSellCents: 22900,
    },
    {
      key: 'repair_contactor',
      name: 'Contactor Replacement',
      categorySlug: 'repair',
      kind: 'SERVICE',
      defaultSellCents: 24900,
    },
    {
      key: 'repair_blower_motor',
      name: 'Blower Motor Replacement',
      categorySlug: 'repair',
      kind: 'SERVICE',
      defaultSellCents: 48900,
    },
    {
      key: 'maintenance_tuneup',
      name: 'Precision Tune-Up',
      categorySlug: 'maintenance',
      kind: 'SERVICE',
      defaultSellCents: 14900,
    },
    {
      key: 'maintenance_filter_change',
      name: 'Filter Change & System Check',
      categorySlug: 'maintenance',
      kind: 'SERVICE',
      defaultSellCents: 11900,
    },
    {
      key: 'evap_winterize',
      name: 'Evaporative Cooler Winterize',
      categorySlug: 'evaporative-cooler',
      kind: 'SERVICE',
      defaultSellCents: 13900,
    },
    {
      key: 'evap_dewinterize',
      name: 'Evaporative Cooler De-Winterize',
      categorySlug: 'evaporative-cooler',
      kind: 'SERVICE',
      defaultSellCents: 14900,
    },
    {
      key: 'iaq_uv_kit',
      name: 'UV Air Purifier Kit',
      categorySlug: 'iaq-add-ons',
      kind: 'ADDON',
      defaultSellCents: 34900,
    },
    {
      key: 'iaq_humidifier_pad',
      name: 'Humidifier Pad Replacement',
      categorySlug: 'iaq-add-ons',
      kind: 'ADDON',
      defaultSellCents: 9900,
    },
    {
      key: 'iaq_electronic_filter',
      name: 'Electronic Filter Upgrade',
      categorySlug: 'iaq-add-ons',
      kind: 'ADDON',
      defaultSellCents: 27900,
    },
  ];

  const itemIdByKey = new Map<string, string>();
  for (const item of itemSeeds) {
    const categoryId = categoryIdBySlug.get(item.categorySlug);
    if (!categoryId) {
      continue;
    }
    const existing = await prisma.pricebookItem.findFirst({
      where: {
        orgId,
        categoryId,
        name: item.name,
      },
      orderBy: { createdAt: 'asc' },
    });
    const row = existing
      ? await prisma.pricebookItem.update({
          where: { id: existing.id },
          data: {
            categoryId,
            kind: item.kind,
            name: item.name,
            description: item.description ?? null,
            defaultSellCents: item.defaultSellCents,
            unitType: 'EA',
            active: true,
            tags: item.tags ?? [],
          },
        })
      : await prisma.pricebookItem.create({
          data: {
            orgId,
            categoryId,
            kind: item.kind,
            name: item.name,
            description: item.description ?? null,
            defaultSellCents: item.defaultSellCents,
            unitType: 'EA',
            active: true,
            tags: item.tags ?? [],
          },
        });
    itemIdByKey.set(item.key, row.id);
  }

  const existingPlan = await prisma.maintenancePlan.findFirst({
    where: {
      orgId,
      name: 'Comfort Care Plan',
    },
    orderBy: { createdAt: 'asc' },
  });
  const plan = existingPlan
    ? await prisma.maintenancePlan.update({
        where: { id: existingPlan.id },
        data: {
          active: true,
          benefits: {
            afterHoursLaborMemberRateCents: 15000,
          },
        },
      })
    : await prisma.maintenancePlan.create({
        data: {
          orgId,
          name: 'Comfort Care Plan',
          active: true,
          benefits: {
            afterHoursLaborMemberRateCents: 15000,
          },
        },
      });

  const seedCustomer = await prisma.customer.findFirst({
    where: { orgId },
    orderBy: { createdAt: 'asc' },
  });
  if (seedCustomer) {
    const existingMembership = await prisma.customerMembership.findFirst({
      where: {
        orgId,
        customerId: seedCustomer.id,
      },
      orderBy: { createdAt: 'asc' },
    });
    if (existingMembership) {
      await prisma.customerMembership.update({
        where: { id: existingMembership.id },
        data: {
          planId: plan.id,
          status: 'ACTIVE',
          startAt: existingMembership.startAt ?? new Date(),
        },
      });
    } else {
      await prisma.customerMembership.create({
        data: {
          orgId,
          customerId: seedCustomer.id,
          planId: plan.id,
          status: 'ACTIVE',
          startAt: new Date(),
        },
      });
    }
  }

  const bundleSeeds: Array<{
    name: string;
    includeDiagnostic: boolean;
    defaultLaborHours: number;
    baseItemKeys: string[];
    recommendedAddOnKeys: string[];
  }> = [
    {
      name: 'Capacitor Replacement',
      includeDiagnostic: true,
      defaultLaborHours: 1.0,
      baseItemKeys: ['repair_capacitor'],
      recommendedAddOnKeys: ['maintenance_filter_change', 'iaq_uv_kit'],
    },
    {
      name: 'Contactor Repair Bundle',
      includeDiagnostic: true,
      defaultLaborHours: 1.25,
      baseItemKeys: ['repair_contactor'],
      recommendedAddOnKeys: ['maintenance_tuneup', 'iaq_electronic_filter'],
    },
    {
      name: 'Maintenance Visit Bundle',
      includeDiagnostic: false,
      defaultLaborHours: 1.0,
      baseItemKeys: ['maintenance_tuneup'],
      recommendedAddOnKeys: ['iaq_humidifier_pad', 'iaq_electronic_filter'],
    },
  ];

  for (const bundle of bundleSeeds) {
    const baseItemIds = bundle.baseItemKeys
      .map((key) => itemIdByKey.get(key))
      .filter((value): value is string => Boolean(value));
    const recommendedAddOnItemIds = bundle.recommendedAddOnKeys
      .map((key) => itemIdByKey.get(key))
      .filter((value): value is string => Boolean(value));

    const existing = await prisma.serviceBundleTemplate.findFirst({
      where: {
        orgId,
        name: bundle.name,
      },
      orderBy: { createdAt: 'asc' },
    });
    if (existing) {
      await prisma.serviceBundleTemplate.update({
        where: { id: existing.id },
        data: {
          active: true,
          includeDiagnostic: bundle.includeDiagnostic,
          defaultLaborHours: bundle.defaultLaborHours,
          baseItemIds,
          recommendedAddOnItemIds,
        },
      });
      continue;
    }

    await prisma.serviceBundleTemplate.create({
      data: {
        orgId,
        name: bundle.name,
        active: true,
        includeDiagnostic: bundle.includeDiagnostic,
        defaultLaborHours: bundle.defaultLaborHours,
        baseItemIds,
        recommendedAddOnItemIds,
      },
    });
  }
}

async function main() {
  const org = await prisma.organization.upsert({
    where: { slug: 'russell-comfort' },
    update: { name: 'Russell Comfort Solutions' },
    create: {
      name: 'Russell Comfort Solutions',
      slug: 'russell-comfort',
    },
  });

  await seedRolesAndPermissions(org.id);
  const users = await seedUsers(org.id);
  await seedOrgSafetyState(org.id, users.admin.id);
  await seedPolicy(org.id, users.admin.id);
  await seedTools(org.id);
  await seedExpenseCatalog(org.id);
  await seedServicePricingCatalog(org.id);
  await seedReferralProgram(org.id);

  const existingLead = await prisma.lead.findFirst({ where: { orgId: org.id } });
  if (!existingLead) {
    await seedDomainData(org.id);
  }

  console.log(
    `Seed complete: org=${org.slug}, users=${Object.keys(users).length}, tools=${toolCatalog.length}, permissions=${permissions.length}`,
  );
}

main()
  .catch((error) => {
    console.error(error);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
