/** Sites/Cloudflare Worker route handler. D1 binding: env.DB. Migrations must be applied before serving. */
const PREFIX = '/api/arena';
const ACTIVE_MS = 45_000;
const ROOM_MS = 2 * 60 * 60 * 1000;
const MAX_BODY = 28_000;
const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' } });
class HTTPError extends Error { constructor(status, message) { super(message); this.status = status; } }
function randomHex(n = 16) { return Array.from(crypto.getRandomValues(new Uint8Array(n)), x => x.toString(16).padStart(2,'0')).join(''); }
function roomCode() { const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; return Array.from(crypto.getRandomValues(new Uint8Array(8)), x => alphabet[x % alphabet.length]).join(''); }
async function hash(value) { return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))), x => x.toString(16).padStart(2,'0')).join(''); }
function cleanName(value) { return String(value || 'Rookie').replace(/[\u0000-\u001f\u007f<>]/g, '').trim().slice(0, 20) || 'Rookie'; }
async function body(request) {
  if (!request.headers.get('content-type')?.startsWith('application/json')) throw new HTTPError(415, '请求必须使用 JSON。');
  if (Number(request.headers.get('content-length')) > MAX_BODY) throw new HTTPError(413, '请求内容过大。');
  const reader = request.body?.getReader(); if (!reader) throw new HTTPError(400, '请求内容缺失。');
  let length = 0; const chunks = [];
  while (true) { const { value, done } = await reader.read(); if (done) break; length += value.length; if (length > MAX_BODY) { await reader.cancel(); throw new HTTPError(413, '请求内容过大。'); } chunks.push(value); }
  const bytes = new Uint8Array(length); let offset = 0; for (const part of chunks) { bytes.set(part, offset); offset += part.length; }
  try { const data = JSON.parse(new TextDecoder().decode(bytes)); if (!data || typeof data !== 'object' || Array.isArray(data)) throw 0; return data; } catch { throw new HTTPError(400, '请求格式无效。'); }
}
function sameOrigin(request) {
  const origin = request.headers.get('origin');
  if (origin && origin !== new URL(request.url).origin) throw new HTTPError(403, '不允许跨站请求。');
  if (request.headers.get('sec-fetch-site') === 'cross-site') throw new HTTPError(403, '不允许跨站请求。');
}
async function auth(db, request, code, now) {
  const id = request.headers.get('x-arena-peer') || '';
  const token = request.headers.get('authorization')?.replace(/^Bearer /, '') || '';
  if (!/^[a-f0-9]{32}$/.test(id) || !/^[a-f0-9]{64}$/.test(token)) throw new HTTPError(401, '请先加入房间。');
  const member = await db.prepare('SELECT * FROM arena_members WHERE room_code = ? AND peer_id = ? AND token_hash = ?').bind(code, id, await hash(token)).first();
  if (!member || member.last_seen < now - ACTIVE_MS) throw new HTTPError(401, '房间会话已过期，请重新加入。');
  return member;
}
async function activeRoom(db, code, now) {
  const room = await db.prepare('SELECT * FROM arena_rooms WHERE code = ?').bind(code).first();
  if (!room || room.closed || room.expires_at <= now) throw new HTTPError(410, '房间不存在或已结束。');
  const host = await db.prepare('SELECT last_seen FROM arena_members WHERE room_code = ? AND peer_id = ?').bind(code, room.host_id).first();
  if (!host || host.last_seen < now - ACTIVE_MS) {
    await db.prepare('UPDATE arena_rooms SET closed = 1 WHERE code = ?').bind(code).run();
    throw new HTTPError(410, '房主已离开，请新建房间继续游玩。');
  }
  return room;
}
async function peers(db, code, now) {
  return (await db.prepare('SELECT peer_id AS id, name FROM arena_members WHERE room_code = ? AND last_seen >= ? ORDER BY joined_at, peer_id').bind(code, now - ACTIVE_MS).all()).results;
}
async function cleanup(db, now) {
  await db.batch([
    db.prepare('DELETE FROM arena_signals WHERE created_at < ?').bind(now - 120_000),
    db.prepare('DELETE FROM arena_members WHERE room_code IN (SELECT code FROM arena_rooms WHERE expires_at < ? OR closed = 1)').bind(now),
    db.prepare('DELETE FROM arena_rooms WHERE expires_at < ? OR closed = 1').bind(now)
  ]);
}
/** Returns null for non-arena paths. */
export async function handleArenaRequest(request, env) {
  const url = new URL(request.url);
  if (!url.pathname.startsWith(PREFIX + '/')) return null;
  if (!env.DB) return json({ error: '联机存储尚未配置，仍可进行单人练习。' }, 503);
  try {
    sameOrigin(request);
    const db = env.DB, now = Date.now();
    if (url.pathname === PREFIX + '/rooms' && request.method === 'POST') {
      const data = await body(request); await cleanup(db, now);
      const code = roomCode(), id = randomHex(), token = randomHex(32), name = cleanName(data.name);
      await db.batch([
        db.prepare('INSERT INTO arena_rooms (code,host_id,created_at,expires_at) VALUES (?,?,?,?)').bind(code,id,now,now+ROOM_MS),
        db.prepare('INSERT INTO arena_members (room_code,peer_id,token_hash,name,joined_at,last_seen) VALUES (?,?,?,?,?,?)').bind(code,id,await hash(token),name,now,now)
      ]);
      return json({ code, selfId:id, hostId:id, token, peers:[{id,name}], expiresAt:now+ROOM_MS });
    }
    const match = url.pathname.match(/^\/api\/arena\/rooms\/([A-Z2-9]{8})\/(join|poll|signal|leave|exchange)$/);
    if (!match) return json({ error:'未找到此接口。' },404);
    const [,code,action] = match;
    if (action === 'join' && request.method === 'POST') {
      const data = await body(request), room = await activeRoom(db,code,now);
      const id = randomHex(), token = randomHex(32), name = cleanName(data.name);
      const result = await db.prepare('INSERT INTO arena_members (room_code,peer_id,token_hash,name,joined_at,last_seen) SELECT ?,?,?,?,?,? WHERE (SELECT COUNT(*) FROM arena_members WHERE room_code = ? AND last_seen >= ?) < 6 AND EXISTS (SELECT 1 FROM arena_rooms WHERE code = ? AND closed = 0 AND expires_at > ?)').bind(code,id,await hash(token),name,now,now,code,now-ACTIVE_MS,code,now).run();
      if (!result.meta.changes) throw new HTTPError(409, '房间已满或已结束，最多六名玩家。');
      return json({code,selfId:id,hostId:room.host_id,token,peers:await peers(db,code,now),expiresAt:room.expires_at});
    }
    const member = await auth(db,request,code,now);
    if (action === 'leave' && request.method === 'POST') {
      const room = await db.prepare('SELECT host_id FROM arena_rooms WHERE code = ?').bind(code).first();
      await db.prepare('DELETE FROM arena_members WHERE room_code = ? AND peer_id = ?').bind(code,member.peer_id).run();
      if (room?.host_id === member.peer_id) await db.prepare('UPDATE arena_rooms SET closed = 1 WHERE code = ?').bind(code).run();
      return json({ok:true});
    }
    const room = await activeRoom(db,code,now);
    if (action === 'exchange' && request.method === 'POST') {
      const data = await body(request);
      const gate = await db.prepare('UPDATE arena_members SET last_exchange_at = ?, last_seen = ? WHERE room_code = ? AND peer_id = ? AND last_exchange_at <= ?').bind(now,now,code,member.peer_id,now-180).run();
      if (!gate.meta.changes) throw new HTTPError(429,'兼容联机请求过快，请稍后重试。');
      if (member.peer_id === room.host_id) {
        if (data.snapshot !== undefined) {
          const snap=data.snapshot, encoded=JSON.stringify(snap);
          if (!snap || typeof snap !== 'object' || !snap.players || typeof snap.players !== 'object' || Array.isArray(snap.players) || Object.keys(snap.players).length > 6 || !Array.isArray(snap.walls) || snap.walls.length > 200 || !Array.isArray(snap.bullets) || snap.bullets.length > 400 || encoded.length > 24000 || !Number.isSafeInteger(data.seq) || data.seq < 1) throw new HTTPError(400,'战场快照无效或过大。');
          await db.prepare('UPDATE arena_rooms SET snapshot = ?, snapshot_seq = ?, snapshot_at = ? WHERE code = ? AND snapshot_seq < ?').bind(encoded,data.seq,now,code,data.seq).run();
        }
        const inputs=(await db.prepare('SELECT peer_id AS id, input, input_seq AS seq, last_input_at AS at FROM arena_members WHERE room_code = ? AND peer_id != ? AND last_seen >= ?').bind(code,member.peer_id,now-ACTIVE_MS).all()).results;
        return json({inputs:inputs.map(p=>({...p,input:p.input ? JSON.parse(p.input) : null})),serverTime:now});
      }
      if (data.snapshot !== undefined) throw new HTTPError(403,'只有房主可以同步战场快照。');
      if (data.input !== undefined) {
        const v=data.input;
        if (!v || !['mx','my','angle'].every(k=>Number.isFinite(v[k])) || !Number.isSafeInteger(data.seq) || data.seq < 1) throw new HTTPError(400,'玩家操作无效。');
        const input={mx:Math.max(-1,Math.min(1,v.mx)),my:Math.max(-1,Math.min(1,v.my)),angle:v.angle,fire:!!v.fire,dash:!!v.dash,reload:!!v.reload};
        await db.prepare('UPDATE arena_members SET input = ?, input_seq = ?, last_input_at = ? WHERE room_code = ? AND peer_id = ? AND input_seq < ?').bind(JSON.stringify(input),data.seq,now,code,member.peer_id,data.seq).run();
      }
      const latest=await db.prepare('SELECT snapshot, snapshot_seq AS seq, snapshot_at AS at FROM arena_rooms WHERE code = ?').bind(code).first();
      return json({snapshot:latest.snapshot ? JSON.parse(latest.snapshot) : null,seq:latest.seq,at:latest.at,serverTime:now});
    }
    if (action === 'poll' && request.method === 'GET') {
      await db.prepare('UPDATE arena_members SET last_seen = ? WHERE room_code = ? AND peer_id = ?').bind(now,code,member.peer_id).run();
      const after = Math.max(0,Math.min(Number.MAX_SAFE_INTEGER,Math.floor(Number(url.searchParams.get('after'))||0)));
      const signals = (await db.prepare('SELECT id,sender,kind,payload FROM arena_signals WHERE room_code = ? AND recipient = ? AND id > ? AND created_at >= ? ORDER BY id LIMIT 100').bind(code,member.peer_id,after,now-120_000).all()).results;
      return json({hostId:room.host_id, peers:await peers(db,code,now), signals:signals.map(s=>({...s,payload:JSON.parse(s.payload)})), serverTime:now});
    }
    if (action === 'signal' && request.method === 'POST') {
      const data = await body(request);
      if (!/^[a-f0-9]{32}$/.test(data.to || '') || data.to === member.peer_id || !['offer','answer','ice','restart'].includes(data.kind)) throw new HTTPError(400,'连接信号无效。');
      const payload = JSON.stringify(data.payload);
      if (!data.payload || typeof data.payload !== 'object' || !payload || payload.length > 24_000) throw new HTTPError(400,'连接信号内容无效。');
      const target = await db.prepare('SELECT peer_id FROM arena_members WHERE room_code = ? AND peer_id = ? AND last_seen >= ?').bind(code,data.to,now-ACTIVE_MS).first();
      if (!target) throw new HTTPError(404,'玩家已离开。');
      const count = await db.prepare('SELECT COUNT(*) AS n FROM arena_signals WHERE room_code = ? AND sender = ? AND created_at > ?').bind(code,member.peer_id,now-10_000).first();
      if (count.n >= 160) throw new HTTPError(429,'连接请求过多，请稍后重试。');
      await db.prepare('INSERT INTO arena_signals (room_code,sender,recipient,kind,payload,created_at) VALUES (?,?,?,?,?,?)').bind(code,member.peer_id,data.to,data.kind,payload,now).run();
      return json({ok:true});
    }
    return json({error:'不支持此请求方式。'},405);
  } catch (error) {
    if (error instanceof HTTPError) return json({error:error.message},error.status);
    console.error('Arena signaling failed:', error?.message || 'unknown');
    return json({error:'房间服务暂不可用，请稍后重试。'},503);
  }
}
