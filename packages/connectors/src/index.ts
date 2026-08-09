export type {
  CommsChannelValue,
  CommsDirectionValue,
  CommsParticipant,
  Connector,
  ConnectorSyncAccount,
  SyncMessageRecord,
  SyncOptions,
  SyncResult,
  SyncThreadRecord,
} from './types.js';

export { createIMessageConnectorMac, IMessageConnectorMac } from './imessage.js';
export { createGmailConnector, GmailConnector } from './gmail.js';
export { readSecretFromMacKeychain } from './keychain.js';
export { sendGmailMessage, sendIMessageViaShortcut } from './senders.js';
