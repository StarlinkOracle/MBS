import { pgTable, text, serial, integer, timestamp, boolean, jsonb } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";

export const contactRequests = pgTable("contact_requests", {
  id: serial("id").primaryKey(),
  firstName: text("first_name").notNull(),
  lastName: text("last_name").notNull(),
  email: text("email").notNull(),
  phone: text("phone").notNull(),
  serviceType: text("service_type"),
  message: text("message"),
  address: text("address"),
  city: text("city"),
  state: text("state"),
  zip: text("zip"),
  preferredDate: text("preferred_date"),
  preferredTime: text("preferred_time"),
  utmSource: text("utm_source"),
  utmMedium: text("utm_medium"),
  utmCampaign: text("utm_campaign"),
  utmContent: text("utm_content"),
  utmTerm: text("utm_term"),
  gclid: text("gclid"),
  gbraid: text("gbraid"),
  wbraid: text("wbraid"),
  fbclid: text("fbclid"),
  landingUrl: text("landing_url"),
  referrerUrl: text("referrer_url"),
  visitorId: text("visitor_id"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  isRead: boolean("is_read").default(false).notNull(),
});

export const quoteComparisons = pgTable("quote_comparisons", {
  id: serial("id").primaryKey(),
  firstName: text("first_name").notNull(),
  lastName: text("last_name").notNull(),
  email: text("email").notNull(),
  phone: text("phone").notNull(),
  serviceType: text("service_type").notNull(),
  competitorName: text("competitor_name"),
  quoteAmount: text("quote_amount"),
  description: text("description"),
  quoteFileUrl: text("quote_file_url"),
  address: text("address"),
  city: text("city"),
  state: text("state"),
  zip: text("zip"),
  utmSource: text("utm_source"),
  utmMedium: text("utm_medium"),
  utmCampaign: text("utm_campaign"),
  utmContent: text("utm_content"),
  utmTerm: text("utm_term"),
  gclid: text("gclid"),
  gbraid: text("gbraid"),
  wbraid: text("wbraid"),
  fbclid: text("fbclid"),
  landingUrl: text("landing_url"),
  referrerUrl: text("referrer_url"),
  visitorId: text("visitor_id"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  isReviewed: boolean("is_reviewed").default(false).notNull(),
  ourQuoteAmount: text("our_quote_amount"),
  status: text("status").default("pending").notNull(),
});

export const contactCrmRequests = pgTable("contact_crm_requests", {
  id: serial("id").primaryKey(),
  contactRequestId: integer("contact_request_id"),
  intakePayload: jsonb("intake_payload").notNull(),
  crmSynced: boolean("crm_synced").default(false).notNull(),
  crmResponse: text("crm_response"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const priceMatchRequests = pgTable("price_match_requests", {
  id: serial("id").primaryKey(),
  quoteComparisonId: integer("quote_comparison_id"),
  intakePayload: jsonb("intake_payload").notNull(),
  crmSynced: boolean("crm_synced").default(false).notNull(),
  crmResponse: text("crm_response"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const attributionEvents = pgTable("attribution_events", {
  id: serial("id").primaryKey(),
  visitorId: text("visitor_id").notNull(),
  eventType: text("event_type").notNull(),
  utmSource: text("utm_source"),
  utmMedium: text("utm_medium"),
  utmCampaign: text("utm_campaign"),
  utmContent: text("utm_content"),
  utmTerm: text("utm_term"),
  gclid: text("gclid"),
  gbraid: text("gbraid"),
  wbraid: text("wbraid"),
  fbclid: text("fbclid"),
  landingUrl: text("landing_url"),
  referrerUrl: text("referrer_url"),
  contactRequestId: integer("contact_request_id"),
  metadata: jsonb("metadata"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const insertContactRequestSchema = createInsertSchema(contactRequests).omit({
  id: true,
  createdAt: true,
  isRead: true,
});

export const insertQuoteComparisonSchema = createInsertSchema(quoteComparisons).omit({
  id: true,
  createdAt: true,
  isReviewed: true,
  ourQuoteAmount: true,
  status: true,
});

export const insertContactCrmRequestSchema = createInsertSchema(contactCrmRequests).omit({
  id: true,
  createdAt: true,
});

export const insertPriceMatchRequestSchema = createInsertSchema(priceMatchRequests).omit({
  id: true,
  createdAt: true,
});

export const insertAttributionEventSchema = createInsertSchema(attributionEvents).omit({
  id: true,
  createdAt: true,
});

export type InsertContactRequest = z.infer<typeof insertContactRequestSchema>;
export type ContactRequest = typeof contactRequests.$inferSelect;
export type InsertQuoteComparison = z.infer<typeof insertQuoteComparisonSchema>;
export type QuoteComparison = typeof quoteComparisons.$inferSelect;
export type InsertAttributionEvent = z.infer<typeof insertAttributionEventSchema>;
export type AttributionEvent = typeof attributionEvents.$inferSelect;
export type InsertContactCrmRequest = z.infer<typeof insertContactCrmRequestSchema>;
export type ContactCrmRequest = typeof contactCrmRequests.$inferSelect;
export type InsertPriceMatchRequest = z.infer<typeof insertPriceMatchRequestSchema>;
export type PriceMatchRequest = typeof priceMatchRequests.$inferSelect;

export const users = pgTable("users", {
  id: serial("id").primaryKey(),
  username: text("username").notNull().unique(),
  password: text("password").notNull(),
});

export const insertUserSchema = createInsertSchema(users).pick({
  username: true,
  password: true,
});

export type InsertUser = z.infer<typeof insertUserSchema>;
export type User = typeof users.$inferSelect;
