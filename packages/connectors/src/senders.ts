import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

function toBase64Url(input: string): string {
  return Buffer.from(input, 'utf8')
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}

export async function sendGmailMessage(input: {
  accessToken: string;
  to: string[];
  subject?: string | null;
  bodyText: string;
  bodyHtml?: string | null;
}): Promise<{ externalMessageId?: string }> {
  const toHeader = input.to.join(', ');
  const subject = input.subject?.trim() ?? '';
  const contentType = input.bodyHtml ? 'text/html; charset=UTF-8' : 'text/plain; charset=UTF-8';
  const body = input.bodyHtml?.trim().length ? input.bodyHtml : input.bodyText;

  const mime = [
    `To: ${toHeader}`,
    subject ? `Subject: ${subject}` : null,
    'MIME-Version: 1.0',
    `Content-Type: ${contentType}`,
    '',
    body,
  ]
    .filter((line): line is string => Boolean(line))
    .join('\r\n');

  const response = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${input.accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ raw: toBase64Url(mime) }),
  });

  if (!response.ok) {
    const payload = await response.text();
    throw new Error(`Gmail send failed (${response.status}): ${payload}`);
  }

  const json = (await response.json()) as { id?: string };
  return { externalMessageId: json.id };
}

export async function sendIMessageViaShortcut(input: {
  recipient: string;
  message: string;
  shortcutName?: string;
}): Promise<void> {
  const shortcutName = input.shortcutName ?? process.env.IMESSAGE_SEND_SHORTCUT_NAME ?? 'Send Message';
  const shortcutInput = JSON.stringify({ recipient: input.recipient, message: input.message });

  await execFileAsync('shortcuts', ['run', shortcutName, '-i', shortcutInput], {
    maxBuffer: 4 * 1024 * 1024,
  });
}
