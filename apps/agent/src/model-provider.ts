export type DraftReplyInput = {
  channel: 'IMESSAGE' | 'SMS' | 'EMAIL';
  customerName?: string | null;
  latestInboundText: string;
  threadSummary?: string | null;
};

export type DraftReplyResult = {
  bodyText: string;
  subject?: string;
};

export interface ModelProvider {
  draftReply(input: DraftReplyInput): Promise<DraftReplyResult | null>;
}

class NoopModelProvider implements ModelProvider {
  async draftReply(): Promise<DraftReplyResult | null> {
    return null;
  }
}

class HttpModelProvider implements ModelProvider {
  constructor(private readonly endpoint: string, private readonly apiKey?: string) {}

  async draftReply(input: DraftReplyInput): Promise<DraftReplyResult | null> {
    const response = await fetch(this.endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(this.apiKey ? { Authorization: `Bearer ${this.apiKey}` } : {}),
      },
      body: JSON.stringify({
        task: 'draft_reply',
        input,
      }),
    });

    if (!response.ok) {
      return null;
    }

    const payload = (await response.json()) as {
      bodyText?: unknown;
      subject?: unknown;
    };

    if (typeof payload.bodyText !== 'string' || payload.bodyText.trim().length === 0) {
      return null;
    }

    return {
      bodyText: payload.bodyText.trim(),
      ...(typeof payload.subject === 'string' && payload.subject.trim().length > 0
        ? { subject: payload.subject.trim() }
        : {}),
    };
  }
}

export function createModelProviderFromEnv(): ModelProvider {
  const endpoint = process.env.AGENT_MODEL_ENDPOINT?.trim();
  if (!endpoint) {
    return new NoopModelProvider();
  }

  return new HttpModelProvider(endpoint, process.env.AGENT_MODEL_API_KEY);
}
