import { sqliteTable, text, integer, primaryKey, index } from 'drizzle-orm/sqlite-core';
export const arenaRooms = sqliteTable('arena_rooms', {
  code: text('code').primaryKey().notNull(),
  hostId: text('host_id').notNull(),
  createdAt: integer('created_at').notNull(),
  expiresAt: integer('expires_at').notNull(),
  closed: integer('closed').notNull().default(0),
  snapshot: text('snapshot'),
  snapshotSeq: integer('snapshot_seq').notNull().default(0),
  snapshotAt: integer('snapshot_at').notNull().default(0),
});
export const arenaMembers = sqliteTable('arena_members', {
  roomCode: text('room_code').notNull(),
  peerId: text('peer_id').notNull(),
  tokenHash: text('token_hash').notNull(),
  name: text('name').notNull(),
  joinedAt: integer('joined_at').notNull(),
  lastSeen: integer('last_seen').notNull(),
  input: text('input'),
  inputSeq: integer('input_seq').notNull().default(0),
  lastInputAt: integer('last_input_at').notNull().default(0),
  lastExchangeAt: integer('last_exchange_at').notNull().default(0),
}, table => [primaryKey({ columns: [table.roomCode, table.peerId] }), index('arena_members_seen').on(table.roomCode, table.lastSeen)]);
export const arenaSignals = sqliteTable('arena_signals', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  roomCode: text('room_code').notNull(),
  sender: text('sender').notNull(),
  recipient: text('recipient').notNull(),
  kind: text('kind').notNull(),
  payload: text('payload').notNull(),
  createdAt: integer('created_at').notNull(),
}, table => [index('arena_signal_recipient').on(table.roomCode, table.recipient, table.id), index('arena_signal_created').on(table.createdAt)]);
