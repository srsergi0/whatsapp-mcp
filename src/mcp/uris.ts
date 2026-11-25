/** Resource URI scheme: whatsapp://<session>/<kind>/... (all segments percent-encoded). */
const enc = encodeURIComponent;

export const uris = {
  sessions: () => 'whatsapp://sessions',
  status: (s: string) => `whatsapp://${enc(s)}/status`,
  chats: (s: string) => `whatsapp://${enc(s)}/chats`,
  chat: (s: string, jid: string) => `whatsapp://${enc(s)}/chat/${enc(jid)}`,
  messages: (s: string, jid: string) => `whatsapp://${enc(s)}/chat/${enc(jid)}/messages`,
  contact: (s: string, jid: string) => `whatsapp://${enc(s)}/contact/${enc(jid)}`,
  group: (s: string, jid: string) => `whatsapp://${enc(s)}/group/${enc(jid)}`,
  media: (s: string, jid: string, id: string) => `whatsapp://${enc(s)}/media/${enc(jid)}/${enc(id)}`,
  memory: (s: string, jid: string) => `whatsapp://${enc(s)}/memory/${enc(jid)}`,
  unread: (s: string) => `whatsapp://${enc(s)}/unread`,
  inbox: (s: string) => `whatsapp://${enc(s)}/inbox`,
  events: (s: string) => `whatsapp://${enc(s)}/events`,
  eventsLatest: () => 'whatsapp://events/latest',
  chatStream: (s: string, jid: string) => `whatsapp://${enc(s)}/chat/${enc(jid)}/stream`,
};

export const mediaFileUri = uris.media;
