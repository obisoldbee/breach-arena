import { handleArenaRequest } from './worker-handler.js';

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname.startsWith('/api/arena')) {
      return await handleArenaRequest(request, env) || new Response('Not found', { status: 404 });
    }
    if (url.pathname === '/') return Response.redirect(new URL('/game/index.html', url), 302);
    return env.ASSETS.fetch(request);
  },
};
