import { MailService } from '@sendgrid/mail';

if (!process.env.SENDGRID_API_KEY) {
  throw new Error("SENDGRID_API_KEY environment variable must be set");
}

const mailService = new MailService();
mailService.setApiKey(process.env.SENDGRID_API_KEY);

interface EmailParams {
  to: string;
  from: string;
  subject: string;
  text?: string;
  html?: string;
}

export async function sendEmail(params: EmailParams): Promise<boolean> {
  try {
    await mailService.send({
      to: params.to,
      from: params.from,
      subject: params.subject,
      text: params.text || '',
      html: params.html || '',
    });
    return true;
  } catch (error) {
    console.error('SendGrid email error:', error);
    return false;
  }
}

export function generateContactEmailHtml(data: any) {
  const addressParts = [data.address, data.city, data.state, data.zip].filter(Boolean);
  const addressLine = addressParts.length > 0 ? addressParts.join(', ') : null;

  const attributionParts: string[] = [];
  if (data.utmSource) attributionParts.push(`<li><strong>Source:</strong> ${data.utmSource}</li>`);
  if (data.utmMedium) attributionParts.push(`<li><strong>Medium:</strong> ${data.utmMedium}</li>`);
  if (data.utmCampaign) attributionParts.push(`<li><strong>Campaign:</strong> ${data.utmCampaign}</li>`);
  if (data.utmContent) attributionParts.push(`<li><strong>Content:</strong> ${data.utmContent}</li>`);
  if (data.utmTerm) attributionParts.push(`<li><strong>Term:</strong> ${data.utmTerm}</li>`);
  if (data.gclid) attributionParts.push(`<li><strong>Google Click ID:</strong> ${data.gclid}</li>`);
  if (data.gbraid) attributionParts.push(`<li><strong>Google gbraid:</strong> ${data.gbraid}</li>`);
  if (data.wbraid) attributionParts.push(`<li><strong>Google wbraid:</strong> ${data.wbraid}</li>`);
  if (data.fbclid) attributionParts.push(`<li><strong>Facebook Click ID:</strong> ${data.fbclid}</li>`);
  if (data.landingUrl) attributionParts.push(`<li><strong>Landing Page:</strong> ${data.landingUrl}</li>`);
  if (data.referrerUrl) attributionParts.push(`<li><strong>Referrer:</strong> ${data.referrerUrl}</li>`);
  if (data.visitorId) attributionParts.push(`<li><strong>Visitor ID:</strong> ${data.visitorId}</li>`);

  return `
    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
      <h2 style="color: #186b6b;">New Contact Form Submission - Russell Comfort Solutions</h2>
      
      <div style="background: #f8f9fa; padding: 20px; border-radius: 8px; margin: 20px 0;">
        <h3 style="color: #333; margin-top: 0;">Customer Information</h3>
        <p><strong>Name:</strong> ${data.firstName} ${data.lastName}</p>
        <p><strong>Email:</strong> <a href="mailto:${data.email}">${data.email}</a></p>
        <p><strong>Phone:</strong> <a href="tel:${data.phone}">${data.phone}</a></p>
        ${data.serviceType ? `<p><strong>Service Needed:</strong> ${data.serviceType}</p>` : ''}
        ${addressLine ? `<p><strong>Address:</strong> ${addressLine}</p>` : ''}
        ${data.preferredDate ? `<p><strong>Preferred Date:</strong> ${data.preferredDate}</p>` : ''}
        ${data.preferredTime ? `<p><strong>Preferred Time:</strong> ${data.preferredTime}</p>` : ''}
      </div>
      
      ${data.message ? `
        <div style="background: #fff; padding: 20px; border-left: 4px solid #dc2626; margin: 20px 0;">
          <h3 style="color: #333; margin-top: 0;">Message</h3>
          <p style="white-space: pre-line;">${data.message}</p>
        </div>
      ` : ''}
      
      ${attributionParts.length > 0 ? `
        <div style="background: #f0f9ff; padding: 20px; border-left: 4px solid #0284c7; margin: 20px 0;">
          <h3 style="color: #333; margin-top: 0;">Attribution Data</h3>
          <ul style="list-style: none; padding: 0; margin: 0;">
            ${attributionParts.join('')}
          </ul>
        </div>
      ` : ''}
      
      <div style="background: #186b6b; color: white; padding: 15px; border-radius: 8px; text-align: center; margin: 20px 0;">
        <p style="margin: 0;">Please respond to this inquiry within 24 hours for best customer experience.</p>
      </div>
    </div>
  `;
}

export function generateQuoteComparisonEmailHtml(data: any) {
  const addressParts = [data.address, data.city, data.state, data.zip].filter(Boolean);
  const addressLine = addressParts.length > 0 ? addressParts.join(', ') : null;

  const attributionParts: string[] = [];
  if (data.utmSource) attributionParts.push(`<li><strong>Source:</strong> ${data.utmSource}</li>`);
  if (data.utmMedium) attributionParts.push(`<li><strong>Medium:</strong> ${data.utmMedium}</li>`);
  if (data.utmCampaign) attributionParts.push(`<li><strong>Campaign:</strong> ${data.utmCampaign}</li>`);
  if (data.gclid) attributionParts.push(`<li><strong>Google Click ID:</strong> ${data.gclid}</li>`);
  if (data.gbraid) attributionParts.push(`<li><strong>Google gbraid:</strong> ${data.gbraid}</li>`);
  if (data.wbraid) attributionParts.push(`<li><strong>Google wbraid:</strong> ${data.wbraid}</li>`);
  if (data.fbclid) attributionParts.push(`<li><strong>Facebook Click ID:</strong> ${data.fbclid}</li>`);
  if (data.landingUrl) attributionParts.push(`<li><strong>Landing Page:</strong> ${data.landingUrl}</li>`);
  if (data.referrerUrl) attributionParts.push(`<li><strong>Referrer:</strong> ${data.referrerUrl}</li>`);
  if (data.visitorId) attributionParts.push(`<li><strong>Visitor ID:</strong> ${data.visitorId}</li>`);

  return `
    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
      <h2 style="color: #186b6b;">Quote Comparison Request - Russell Comfort Solutions</h2>
      
      <div style="background: #f8f9fa; padding: 20px; border-radius: 8px; margin: 20px 0;">
        <h3 style="color: #333; margin-top: 0;">Customer Information</h3>
        <p><strong>Name:</strong> ${data.firstName} ${data.lastName}</p>
        <p><strong>Email:</strong> <a href="mailto:${data.email}">${data.email}</a></p>
        <p><strong>Phone:</strong> <a href="tel:${data.phone}">${data.phone}</a></p>
        <p><strong>Service Type:</strong> ${data.serviceType}</p>
        ${addressLine ? `<p><strong>Address:</strong> ${addressLine}</p>` : ''}
        ${data.competitorName ? `<p><strong>Competitor Company:</strong> ${data.competitorName}</p>` : ''}
        ${data.quoteAmount ? `<p><strong>Competitor Quote Amount:</strong> $${data.quoteAmount}</p>` : ''}
      </div>
      
      ${data.hasAttachment ? `
        <div style="background: #e6f3ff; padding: 20px; border-left: 4px solid #0066cc; margin: 20px 0;">
          <h3 style="color: #333; margin-top: 0;">File Attachment</h3>
          <p><strong>Customer uploaded:</strong> ${data.attachmentName}</p>
          <p style="font-size: 14px; color: #666;">Check the admin panel to view the attachment details.</p>
        </div>
      ` : ''}

      ${data.description ? `
        <div style="background: #fff; padding: 20px; border-left: 4px solid #dc2626; margin: 20px 0;">
          <h3 style="color: #333; margin-top: 0;">Project Description / Notes</h3>
          <p style="white-space: pre-line;">${data.description}</p>
        </div>
      ` : ''}

      ${attributionParts.length > 0 ? `
        <div style="background: #f0f9ff; padding: 20px; border-left: 4px solid #0284c7; margin: 20px 0;">
          <h3 style="color: #333; margin-top: 0;">Attribution Data</h3>
          <ul style="list-style: none; padding: 0; margin: 0;">
            ${attributionParts.join('')}
          </ul>
        </div>
      ` : ''}
      
      <div style="background: #dc2626; color: white; padding: 15px; border-radius: 8px; text-align: center; margin: 20px 0;">
        <p style="margin: 0;"><strong>ACTION REQUIRED:</strong> Review competitor quote and provide matching or better pricing.</p>
      </div>
      
      <div style="background: #186b6b; color: white; padding: 15px; border-radius: 8px; text-align: center;">
        <p style="margin: 0;">Customer expects response within 24 hours${data.hasAttachment ? ' - File attachment available in admin panel' : ''}.</p>
      </div>
    </div>
  `;
}
