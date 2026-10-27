import { env } from 'cloudflare:workers';
import { handleArenaRequest } from '../../../../lib/arena/worker-handler.js';
export const dynamic = 'force-dynamic';
export async function GET(request: Request) { return await handleArenaRequest(request, env) || new Response('Not found', {status:404}); }
export async function POST(request: Request) { return await handleArenaRequest(request, env) || new Response('Not found', {status:404}); }
