import { 
  users, contactRequests, quoteComparisons, attributionEvents, priceMatchRequests, contactCrmRequests,
  type User, type InsertUser, 
  type ContactRequest, type InsertContactRequest,
  type QuoteComparison, type InsertQuoteComparison,
  type AttributionEvent, type InsertAttributionEvent,
  type PriceMatchRequest, type InsertPriceMatchRequest,
  type ContactCrmRequest, type InsertContactCrmRequest
} from "@shared/schema";
import { db } from "./db";
import { eq } from "drizzle-orm";

export interface IStorage {
  getUser(id: number): Promise<User | undefined>;
  getUserByUsername(username: string): Promise<User | undefined>;
  createUser(user: InsertUser): Promise<User>;
  createContactRequest(request: InsertContactRequest): Promise<ContactRequest>;
  getContactRequests(): Promise<ContactRequest[]>;
  markContactRequestAsRead(id: number): Promise<void>;
  createQuoteComparison(request: InsertQuoteComparison): Promise<QuoteComparison>;
  getQuoteComparisons(): Promise<QuoteComparison[]>;
  updateQuoteComparison(id: number, updates: Partial<QuoteComparison>): Promise<void>;
  createAttributionEvent(event: InsertAttributionEvent): Promise<AttributionEvent>;
  createPriceMatchRequest(request: InsertPriceMatchRequest): Promise<PriceMatchRequest>;
  createContactCrmRequest(request: InsertContactCrmRequest): Promise<ContactCrmRequest>;
}

export class DatabaseStorage implements IStorage {
  async getUser(id: number): Promise<User | undefined> {
    const [user] = await db.select().from(users).where(eq(users.id, id));
    return user || undefined;
  }

  async getUserByUsername(username: string): Promise<User | undefined> {
    const [user] = await db.select().from(users).where(eq(users.username, username));
    return user || undefined;
  }

  async createUser(insertUser: InsertUser): Promise<User> {
    const [user] = await db
      .insert(users)
      .values(insertUser)
      .returning();
    return user;
  }

  async createContactRequest(request: InsertContactRequest): Promise<ContactRequest> {
    const [contactRequest] = await db
      .insert(contactRequests)
      .values(request)
      .returning();
    return contactRequest;
  }

  async getContactRequests(): Promise<ContactRequest[]> {
    return await db
      .select()
      .from(contactRequests)
      .orderBy(contactRequests.createdAt);
  }

  async markContactRequestAsRead(id: number): Promise<void> {
    await db
      .update(contactRequests)
      .set({ isRead: true })
      .where(eq(contactRequests.id, id));
  }

  async createQuoteComparison(request: InsertQuoteComparison): Promise<QuoteComparison> {
    const [quoteComparison] = await db
      .insert(quoteComparisons)
      .values(request)
      .returning();
    return quoteComparison;
  }

  async getQuoteComparisons(): Promise<QuoteComparison[]> {
    return await db
      .select()
      .from(quoteComparisons)
      .orderBy(quoteComparisons.createdAt);
  }

  async updateQuoteComparison(id: number, updates: Partial<QuoteComparison>): Promise<void> {
    await db
      .update(quoteComparisons)
      .set(updates)
      .where(eq(quoteComparisons.id, id));
  }

  async createAttributionEvent(event: InsertAttributionEvent): Promise<AttributionEvent> {
    const [attributionEvent] = await db
      .insert(attributionEvents)
      .values(event)
      .returning();
    return attributionEvent;
  }

  async createPriceMatchRequest(request: InsertPriceMatchRequest): Promise<PriceMatchRequest> {
    const [pmr] = await db
      .insert(priceMatchRequests)
      .values(request)
      .returning();
    return pmr;
  }

  async createContactCrmRequest(request: InsertContactCrmRequest): Promise<ContactCrmRequest> {
    const [ccr] = await db
      .insert(contactCrmRequests)
      .values(request)
      .returning();
    return ccr;
  }
}

export const storage = new DatabaseStorage();
