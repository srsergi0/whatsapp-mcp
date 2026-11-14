import { z } from 'zod';
import { toJid } from '../../wa/jid.js';
import { defineTool, limitField, sessionField, type Env } from '../helpers.js';

/* eslint-disable @typescript-eslint/no-explicit-any */

export function registerBusinessTools(env: Env) {
  defineTool(env, 'catalog', {
    title: 'Business catalog',
    description: 'Read the product catalog and collections of a WhatsApp Business account (yours or another business).',
    toolset: 'business',
    network: true,
    input: {
      session: sessionField,
      jid: z.string().optional().describe('Business to read; default: your own account.'),
      what: z.enum(['products', 'collections']).default('products'),
      limit: limitField(20, 100),
      cursor: z.string().optional(),
    },
  }, async (a, ctx) => {
    const s = await ctx.open(a.session);
    const sock = s.socket();
    const jid = a.jid ? ctx.jid(s.name, a.jid) : undefined;
    if (a.what === 'collections') return { collections: await sock.getCollections(jid ? toJid(jid) : undefined, a.limit) };
    return await sock.getCatalog({ jid: jid ? toJid(jid) : undefined, limit: a.limit, cursor: a.cursor } as any);
  });

  defineTool(env, 'product_manage', {
    title: 'Create / update / delete catalog products',
    description: 'Manage products of your WhatsApp Business catalog (requires a Business account).',
    toolset: 'business',
    effect: 'wa',
    destructive: true,
    input: {
      session: sessionField,
      action: z.enum(['create', 'update', 'delete']),
      product_id: z.string().optional().describe('For update.'),
      product_ids: z.array(z.string()).optional().describe('For delete.'),
      name: z.string().optional(),
      description: z.string().optional(),
      price: z.number().optional().describe('Price in major units (e.g. 19.99).'),
      currency: z.string().length(3).optional(),
      image_urls: z.array(z.string()).optional(),
      url: z.string().optional(),
      retailer_id: z.string().optional(),
      is_hidden: z.boolean().optional(),
    },
  }, async (a, ctx) => {
    const s = await ctx.openForWrite(a.session);
    const sock = s.socket();
    const body: any = {
      name: a.name, description: a.description, price: a.price !== undefined ? Math.round(a.price * 1000) : undefined, currency: a.currency,
      images: a.image_urls?.map((u) => ({ url: u })), originCountryCode: undefined, url: a.url, retailerId: a.retailer_id, isHidden: a.is_hidden,
    };
    Object.keys(body).forEach((k) => body[k] === undefined && delete body[k]);
    if (a.action === 'create') {
      if (!a.name || a.price === undefined || !a.currency) throw new Error('name, price and currency are required to create a product.');
      return { product: await sock.productCreate({ ...body, originCountryCode: undefined } as any) };
    }
    if (a.action === 'update') {
      if (!a.product_id) throw new Error('product_id required');
      return { product: await sock.productUpdate(a.product_id, body) };
    }
    if (!a.product_ids?.length) throw new Error('product_ids required');
    return await sock.productDelete(a.product_ids);
  });

  defineTool(env, 'order_details', {
    title: 'Order details',
    description: 'Get the details of an order received in a chat (order id and token come from the order message extra data).',
    toolset: 'business',
    network: true,
    input: { session: sessionField, order_id: z.string(), token: z.string() },
  }, async (a, ctx) => {
    const s = await ctx.open(a.session);
    return { order: await s.socket().getOrderDetails(a.order_id, a.token) };
  });

  defineTool(env, 'channel', {
    title: 'WhatsApp Channels (newsletters)',
    description: 'info: metadata by invite code or jid. follow / unfollow / mute / unmute a channel. create: make your own channel. To post, use send_text with the channel jid (…@newsletter).',
    toolset: 'business',
    effect: 'wa',
    input: {
      session: sessionField,
      action: z.enum(['info', 'follow', 'unfollow', 'mute', 'unmute', 'create']),
      channel: z.string().optional().describe('Channel jid (…@newsletter) or invite code / link.'),
      name: z.string().optional(),
      description: z.string().optional(),
    },
  }, async (a, ctx) => {
    const s = a.action === 'info' ? await ctx.open(a.session) : await ctx.openForWrite(a.session);
    const sock = s.socket();
    if (a.action === 'create') {
      if (!a.name) throw new Error('name required');
      return { channel: await sock.newsletterCreate(a.name, a.description) };
    }
    if (!a.channel) throw new Error('channel required');
    const isJid = a.channel.endsWith('@newsletter');
    const code = a.channel.replace(/^.*whatsapp\.com\/channel\//i, '');
    if (a.action === 'info') return { channel: await sock.newsletterMetadata(isJid ? 'jid' : 'invite', isJid ? a.channel : code) };
    let jid = a.channel;
    if (!isJid) jid = (await sock.newsletterMetadata('invite', code))?.id ?? '';
    if (!jid) throw new Error('Channel not found');
    if (a.action === 'follow') await sock.newsletterFollow(jid);
    else if (a.action === 'unfollow') await sock.newsletterUnfollow(jid);
    else if (a.action === 'mute') await sock.newsletterMute(jid);
    else await sock.newsletterUnmute(jid);
    return { channel: jid, action: a.action };
  });
}
