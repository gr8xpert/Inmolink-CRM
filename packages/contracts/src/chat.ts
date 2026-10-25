/**
 * Chat (S11-03, PLAN §7 M12): threads between members — `DIRECT` (colleagues of one agency) and `VIEWING` (the two
 * agencies of an S11-02 viewing request) — messages, read state, live delivery over apps/realtime (`/chat`) with a
 * typing indicator, WhatsApp / e-mail handoff links. Internal to the agencies: nothing here is open in Client Mode, and
 * nothing names a client (white label): a viewing thread shows the listing's reference and the other agency's name.
 */
import { z } from 'zod';
import { PageQuery, pageOf } from './common';

export const CHAT_LIMITS = {
  /** Characters of one message. */
  bodyChars: 4_000,
  /** Colleagues a `DIRECT` thread is started with (the starter comes on top). */
  directMembers: 19,
  /** Members of one agency in one thread. */
  participants: 50,
  titleChars: 120,
} as const;

export const ChatThreadKind = z.enum(['DIRECT', 'VIEWING', 'NETWORK']);
export type ChatThreadKind = z.infer<typeof ChatThreadKind>;

/**
 * Refused in titles: control characters, line / paragraph separators and invisible format characters (bidi
 * overrides and isolates among them: they make text read differently than it is) — joiners (ZWNJ, ZWJ) excepted.
 */
const NO_CONTROL = /[\p{Cc}\p{Zl}\p{Zp}]|[^\P{Cf}\p{Join_Control}]/u;
/** The same for messages, which keep their line breaks and tabs. */
const NO_CONTROL_TEXT = /[^\P{Cc}\n\r\t]|[\p{Zl}\p{Zp}]|[^\P{Cf}\p{Join_Control}]/u;

/** A message: trimmed, 1–4,000 characters, line breaks and tabs allowed, other control and format characters refused. */
export const ChatMessageText = z
  .string()
  .trim()
  .min(1)
  .max(CHAT_LIMITS.bodyChars)
  .refine((v) => !NO_CONTROL_TEXT.test(v) && !/[\u2028\u2029]/u.test(v), {
    message: 'no control characters',
  });

export const ChatTitle = z
  .string()
  .trim()
  .min(1)
  .max(CHAT_LIMITS.titleChars)
  .refine((v) => !NO_CONTROL.test(v), { message: 'no control characters' });

export const ChatMessageDto = z.strictObject({
  id: z.uuid(),
  threadId: z.uuid(),
  /** Who wrote it: their agency, id and display name when sent; `ownAgency` false for the other agency's members. */
  sender: z.strictObject({
    agencyId: z.uuid(),
    userId: z.uuid(),
    name: z.string(),
    ownAgency: z.boolean(),
  }),
  body: z.string(),
  createdAt: z.iso.datetime(),
});
export type ChatMessageDto = z.infer<typeof ChatMessageDto>;
export const ChatMessagePage = pageOf(ChatMessageDto);
export type ChatMessagePage = z.infer<typeof ChatMessagePage>;

/** Deep links that carry the conversation elsewhere (no provider keys; the member picks the recipient). */
export const ChatHandoffDto = z.strictObject({
  whatsappUrl: z.string(),
  emailUrl: z.string(),
});
export type ChatHandoffDto = z.infer<typeof ChatHandoffDto>;

export const ChatThreadDto = z.strictObject({
  id: z.uuid(),
  kind: ChatThreadKind,
  /** `VIEWING` only: the viewing request (its id is the thread's). */
  viewingRequestId: z.uuid().nullable(),
  /** `NETWORK` only (S11-05): the network board post this thread replies to. */
  networkPostId: z.uuid().nullable(),
  /** `VIEWING` / `NETWORK`: the other agency and its directory name (null when not listed). */
  peerAgency: z.strictObject({ id: z.uuid(), name: z.string().nullable() }).nullable(),
  /** `DIRECT`: the name its starter gave it (null for none). */
  title: z.string().nullable(),
  /** `VIEWING`: the listing's reference (never the client); `NETWORK`: the post's title. */
  subject: z.string().nullable(),
  lastMessageAt: z.iso.datetime(),
  /** The caller's read state. */
  lastReadAt: z.iso.datetime().nullable(),
  unread: z.boolean(),
  /**
   * Read-only (hide the composer). `VIEWING`: the viewing request was declined, cancelled or expired. `NETWORK`: its
   * post closed (or expired), or either agency is no longer listed (S12-F12).
   */
  closed: z.boolean(),
});
export type ChatThreadDto = z.infer<typeof ChatThreadDto>;
export const ChatThreadPage = pageOf(ChatThreadDto);
export type ChatThreadPage = z.infer<typeof ChatThreadPage>;

/** One thread with the caller's agency's participants (the other agency's members are not listed) and handoff links. */
export const ChatThreadDetailDto = ChatThreadDto.extend({
  participants: z.array(
    z.strictObject({ userId: z.uuid(), name: z.string().nullable(), lastReadAt: z.iso.datetime().nullable() }),
  ),
  handoff: ChatHandoffDto,
});
export type ChatThreadDetailDto = z.infer<typeof ChatThreadDetailDto>;

export const ChatThreadParams = z.object({ id: z.uuid() });

export const ListChatThreadsQuery = PageQuery;
export type ListChatThreadsQuery = z.infer<typeof ListChatThreadsQuery>;
export const ListChatMessagesQuery = PageQuery;
export type ListChatMessagesQuery = z.infer<typeof ListChatMessagesQuery>;

/** `POST /v1/chat/threads`: a `DIRECT` thread with colleagues of the caller's agency. */
export const CreateDirectThreadBody = z.strictObject({
  userIds: z.array(z.uuid()).min(1).max(CHAT_LIMITS.directMembers),
  title: ChatTitle.optional(),
});
export type CreateDirectThreadBody = z.infer<typeof CreateDirectThreadBody>;

/** `POST /v1/chat/viewing-threads`: opens (or joins) the thread of a viewing request the caller's agency is party to. */
export const OpenViewingThreadBody = z.strictObject({ viewingRequestId: z.uuid() });
export type OpenViewingThreadBody = z.infer<typeof OpenViewingThreadBody>;

/** `POST /v1/chat/threads/:id/messages`; `clientKey` (a UUID the client picks) makes a retried send idempotent. */
export const SendChatMessageBody = z.strictObject({
  body: ChatMessageText,
  clientKey: z.uuid().optional(),
});
export type SendChatMessageBody = z.infer<typeof SendChatMessageBody>;

export const SendChatMessageDto = z.strictObject({ message: ChatMessageDto, replayed: z.boolean() });
export type SendChatMessageDto = z.infer<typeof SendChatMessageDto>;

/** `POST /v1/chat/threads/:id/read`: everything up to the thread's latest message read. */
export const MarkChatReadDto = z.strictObject({ threadId: z.uuid(), lastReadAt: z.iso.datetime().nullable() });
export type MarkChatReadDto = z.infer<typeof MarkChatReadDto>;

/* ------------------------------------------------------------------ realtime (apps/realtime `/chat`) */

export const REALTIME_CHAT_NAMESPACE = '/chat';
/** Server → client events. */
export const REALTIME_CHAT_EVENTS = { message: 'message', read: 'read', typing: 'typing' } as const;
/** Client → server events (each acknowledged with `ChatAck`). */
export const REALTIME_CHAT_CLIENT_EVENTS = { join: 'join', leave: 'leave', typing: 'typing' } as const;

/** A new message, to each participant's own sockets (`user:<agency>:<user>` room). */
export const ChatMessagePush = z.strictObject({ agencyId: z.uuid(), message: ChatMessageDto });
export type ChatMessagePush = z.infer<typeof ChatMessagePush>;

/** A participant read the thread up to `lastReadAt` (read receipt), to every participant of both agencies. */
export const ChatReadPush = z.strictObject({
  agencyId: z.uuid(),
  threadId: z.uuid(),
  reader: z.strictObject({ agencyId: z.uuid(), userId: z.uuid() }),
  lastReadAt: z.iso.datetime(),
});
export type ChatReadPush = z.infer<typeof ChatReadPush>;

/** Someone is typing: to the thread's joined sockets except the typist's own. */
export const ChatTypingPush = z.strictObject({ threadId: z.uuid(), agencyId: z.uuid(), userId: z.uuid() });
export type ChatTypingPush = z.infer<typeof ChatTypingPush>;

/** What a client sends with `join` / `leave` / `typing`. */
export const ChatThreadRef = z.strictObject({ threadId: z.uuid() });
export type ChatThreadRef = z.infer<typeof ChatThreadRef>;

export const ChatAck = z.union([
  z.strictObject({ ok: z.literal(true) }),
  z.strictObject({ ok: z.literal(false), error: z.enum(['FORBIDDEN', 'VALIDATION_FAILED', 'RATE_LIMITED']) }),
]);
export type ChatAck = z.infer<typeof ChatAck>;
