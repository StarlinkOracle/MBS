import type { Express } from "express";
import { createServer, type Server } from "http";
import { storage } from "./storage";
import { insertContactRequestSchema, insertQuoteComparisonSchema, insertAttributionEventSchema } from "@shared/schema";
import { z } from "zod";
import { sendEmail, generateContactEmailHtml, generateQuoteComparisonEmailHtml } from "./email";
import { googleAnalyticsService } from "./analytics";
import { uploadFile, getS3Stream, isS3Configured, type AttachmentMetadata } from "./lib/s3";
import multer from "multer";
import path from "path";
import fs from "fs";

const uploadsDir = path.join(process.cwd(), 'uploads');
if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true });
}

const memoryStorage = multer.memoryStorage();

const upload = multer({
  storage: memoryStorage,
  limits: {
    fileSize: 10 * 1024 * 1024,
  },
  fileFilter: (req, file, cb) => {
    const allowedTypes = ['application/pdf', 'image/jpeg', 'image/jpg', 'image/png'];
    if (allowedTypes.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error('Invalid file type. Only PDF, JPG, and PNG files are allowed.'));
    }
  },
});

async function forwardToCrm(endpoint: string, payload: any): Promise<{ synced: boolean; response: string | null }> {
  if (!process.env.MBS_CRM_INGEST_URL || !process.env.MBS_CRM_INGEST_TOKEN) {
    return { synced: false, response: null };
  }
  try {
    const res = await fetch(`${process.env.MBS_CRM_INGEST_URL}${endpoint}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${process.env.MBS_CRM_INGEST_TOKEN}`,
      },
      body: JSON.stringify(payload),
    });
    const text = await res.text();
    if (!res.ok) {
      console.error(`CRM forward to ${endpoint} returned ${res.status}: ${text}`);
      return {
        synced: false,
        response: JSON.stringify({
          status: res.status,
          body: text,
        }),
      };
    }
    return { synced: true, response: text };
  } catch (err) {
    console.error(`CRM forward to ${endpoint} failed:`, err);
    return { synced: false, response: null };
  }
}

export async function registerRoutes(app: Express): Promise<Server> {
  app.post("/api/contact", async (req, res) => {
    try {
      const validatedData = insertContactRequestSchema.parse(req.body);
      const contactRequest = await storage.createContactRequest(validatedData);

      const emailSent = await sendEmail({
        to: "hvac@russellcomfort.com",
        from: "noreply@russellcomfort.com",
        subject: `New Contact Request from ${validatedData.firstName} ${validatedData.lastName}`,
        html: generateContactEmailHtml(validatedData)
      });

      if (!emailSent) {
        console.error("Failed to send email notification for contact request:", contactRequest.id);
      }

      const intakePayload = {
        ...validatedData,
      };

      const crm = await forwardToCrm("/api/intake/contact", intakePayload);

      await storage.createContactCrmRequest({
        contactRequestId: contactRequest.id,
        intakePayload,
        crmSynced: crm.synced,
        crmResponse: crm.response,
      });

      res.json({
        success: true,
        message: "Thank you for your inquiry! We'll contact you within 24 hours.",
        id: contactRequest.id
      });
    } catch (error) {
      if (error instanceof z.ZodError) {
        res.status(400).json({
          success: false,
          message: "Please fill in all required fields correctly.",
          errors: error.errors
        });
      } else {
        console.error("Contact form error:", error);
        res.status(500).json({
          success: false,
          message: "Sorry, there was an error processing your request. Please try again or call us directly."
        });
      }
    }
  });

  app.post("/api/attribution/capture", async (req, res) => {
    try {
      const data = insertAttributionEventSchema.parse(req.body);
      await storage.createAttributionEvent(data);
      res.json({ success: true });
    } catch (error) {
      if (error instanceof z.ZodError) {
        res.status(400).json({ success: false, message: "Invalid attribution data" });
      } else {
        console.error("Attribution capture error:", error);
        res.status(500).json({ success: false, message: "Error storing attribution" });
      }
    }
  });

  app.post("/api/attribution/convert", async (req, res) => {
    try {
      const data = insertAttributionEventSchema.parse({
        ...req.body,
        eventType: "conversion",
      });
      await storage.createAttributionEvent(data);
      res.json({ success: true });
    } catch (error) {
      if (error instanceof z.ZodError) {
        res.status(400).json({ success: false, message: "Invalid conversion data" });
      } else {
        console.error("Attribution conversion error:", error);
        res.status(500).json({ success: false, message: "Error storing conversion" });
      }
    }
  });

  app.post("/api/quote-comparison", upload.single('quoteFile'), async (req, res) => {
    try {
      const validatedData = insertQuoteComparisonSchema.parse(req.body);

      let attachment: AttachmentMetadata | null = null;
      if (req.file) {
        attachment = await uploadFile(req.file.buffer, req.file.originalname, req.file.mimetype);
      }

      const quoteComparison = await storage.createQuoteComparison({
        ...validatedData,
        quoteFileUrl: attachment ? attachment.objectKey : null
      });

      const intakePayload = {
        lead: {
          name: `${validatedData.firstName} ${validatedData.lastName}`,
          phone: validatedData.phone,
          email: validatedData.email,
          address: [validatedData.address, validatedData.city, validatedData.state, validatedData.zip].filter(Boolean).join(', ') || null,
          serviceType: validatedData.serviceType,
        },
        intakeType: "PRICE_MATCH",
        competitor: {
          name: validatedData.competitorName || null,
          priceCents: validatedData.quoteAmount ? (() => { const n = parseFloat(validatedData.quoteAmount!.replace(/[^0-9.]/g, '')); return isNaN(n) ? null : Math.round(n * 100); })() : null,
          notes: validatedData.description || null,
        },
        attachment: attachment ? {
          provider: attachment.provider,
          bucket: attachment.bucket,
          objectKey: attachment.objectKey,
          fileName: attachment.fileName,
          mimeType: attachment.mimeType,
          sizeBytes: attachment.sizeBytes,
          checksumSha256: attachment.checksumSha256,
          url: attachment.url,
        } : null,
        attribution: {
          utmSource: validatedData.utmSource || null,
          utmMedium: validatedData.utmMedium || null,
          utmCampaign: validatedData.utmCampaign || null,
          utmContent: validatedData.utmContent || null,
          utmTerm: validatedData.utmTerm || null,
          gclid: validatedData.gclid || null,
          gbraid: validatedData.gbraid || null,
          wbraid: validatedData.wbraid || null,
          fbclid: validatedData.fbclid || null,
          landingUrl: validatedData.landingUrl || null,
          referrerUrl: validatedData.referrerUrl || null,
          visitorId: validatedData.visitorId || null,
        },
        source: "website_price_match",
      };

      const crm = await forwardToCrm("/api/intake/price-match", intakePayload);

      await storage.createPriceMatchRequest({
        quoteComparisonId: quoteComparison.id,
        intakePayload,
        crmSynced: crm.synced,
        crmResponse: crm.response,
      });

      const emailSubject = `Quote Comparison Request from ${validatedData.firstName} ${validatedData.lastName}${validatedData.quoteAmount ? ` - $${validatedData.quoteAmount}` : ''}${req.file ? ' (with attachment)' : ''}`;

      const emailSent = await sendEmail({
        to: "hvac@russellcomfort.com",
        from: "noreply@russellcomfort.com",
        subject: emailSubject,
        html: generateQuoteComparisonEmailHtml({
          ...validatedData,
          hasAttachment: !!req.file,
          attachmentName: req.file?.originalname
        })
      });

      if (!emailSent) {
        console.error("Failed to send email notification for quote comparison:", quoteComparison.id);
      }

      res.json({
        success: true,
        message: "We'll review and get back to you within 24 hours with our best price!",
        id: quoteComparison.id
      });
    } catch (error) {
      if (error instanceof z.ZodError) {
        res.status(400).json({
          success: false,
          message: "Please fill in all required fields correctly.",
          errors: error.errors
        });
      } else {
        console.error("Quote comparison error:", error);
        res.status(500).json({
          success: false,
          message: "Sorry, there was an error processing your request. Please try again or call us directly."
        });
      }
    }
  });

  app.get("/api/admin/quotes", async (req, res) => {
    try {
      const quotes = await storage.getQuoteComparisons();
      res.json(quotes);
    } catch (error) {
      console.error("Error fetching quote comparisons:", error);
      res.status(500).json({ success: false, message: "Error fetching quote comparisons" });
    }
  });

  app.get("/api/admin/contacts", async (req, res) => {
    try {
      const contacts = await storage.getContactRequests();
      res.json(contacts);
    } catch (error) {
      console.error("Error fetching contact requests:", error);
      res.status(500).json({ success: false, message: "Error fetching contact requests" });
    }
  });

  app.patch("/api/admin/quotes/:id", async (req, res) => {
    try {
      const id = parseInt(req.params.id);
      const updates = req.body;
      await storage.updateQuoteComparison(id, updates);
      res.json({ success: true });
    } catch (error) {
      console.error("Error updating quote comparison:", error);
      res.status(500).json({ success: false, message: "Error updating quote comparison" });
    }
  });

  app.patch("/api/admin/contacts/:id/read", async (req, res) => {
    try {
      const id = parseInt(req.params.id);
      await storage.markContactRequestAsRead(id);
      res.json({ success: true });
    } catch (error) {
      console.error("Error marking contact as read:", error);
      res.status(500).json({ success: false, message: "Error marking contact as read" });
    }
  });

  app.get("/api/quote-comparisons", async (req, res) => {
    try {
      const comparisons = await storage.getQuoteComparisons();
      res.json(comparisons);
    } catch (error) {
      console.error("Error fetching quote comparisons:", error);
      res.status(500).json({ success: false, message: "Error fetching quote comparisons" });
    }
  });

  app.patch("/api/contact-requests/:id/read", async (req, res) => {
    try {
      const id = parseInt(req.params.id);
      await storage.markContactRequestAsRead(id);
      res.json({ success: true });
    } catch (error) {
      console.error("Error marking contact request as read:", error);
      res.status(500).json({ success: false, message: "Error updating contact request" });
    }
  });

  app.get("/api/admin/analytics", async (req, res) => {
    try {
      const analyticsData = await googleAnalyticsService.getAnalyticsData();
      res.json(analyticsData);
    } catch (error) {
      console.error("Error fetching analytics data:", error);
      res.status(500).json({ success: false, message: "Error fetching analytics data" });
    }
  });

  app.get("/api/admin/quotes/:id/file", async (req, res) => {
    try {
      const id = parseInt(req.params.id);
      const quotes = await storage.getQuoteComparisons();
      const quote = quotes.find(q => q.id === id);

      if (!quote || !quote.quoteFileUrl) {
        return res.status(404).json({ success: false, message: "File not found" });
      }

      const objectKey = quote.quoteFileUrl;

      if (objectKey.includes("/") && isS3Configured()) {
        const s3Result = await getS3Stream(objectKey);
        if (s3Result) {
          const ext = path.extname(objectKey).toLowerCase();
          res.setHeader('Content-Type', s3Result.contentType);
          res.setHeader('Content-Disposition', `inline; filename="quote_${id}${ext}"`);
          (s3Result.stream as any).pipe(res);
          return;
        }
      }

      const filePath = path.join(uploadsDir, objectKey);

      if (!fs.existsSync(filePath)) {
        return res.status(404).json({ success: false, message: "File no longer available" });
      }

      const ext = path.extname(objectKey).toLowerCase();
      const mimeTypes: Record<string, string> = {
        '.pdf': 'application/pdf',
        '.jpg': 'image/jpeg',
        '.jpeg': 'image/jpeg',
        '.png': 'image/png',
      };

      res.setHeader('Content-Type', mimeTypes[ext] || 'application/octet-stream');
      res.setHeader('Content-Disposition', `inline; filename="quote_${id}${ext}"`);
      res.sendFile(filePath);
    } catch (error) {
      console.error("Error serving quote file:", error);
      res.status(500).json({ success: false, message: "Error serving file" });
    }
  });

  const httpServer = createServer(app);
  return httpServer;
}
