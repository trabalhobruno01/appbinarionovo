import {
  API_SECURITY_HEADERS,
  enforceRateLimitOrThrow,
  getClientIpFromHeaders,
  securityErrorResponse,
  SecurityValidationError,
} from '../../server/securityGuard.ts';
import { getSynchronizedBrasiliaTime } from '../../server/timeService.ts';

export default async (req: Request): Promise<Response> => {
  try {
    const ip = getClientIpFromHeaders((name) => req.headers.get(name));
    enforceRateLimitOrThrow({
      key: `nf:time:ip:${ip}`,
      maxRequests: 60,
      windowMs: 60_000,
      route: '/api/time',
    });
    const sync = await getSynchronizedBrasiliaTime(true);
    return Response.json(sync, { headers: API_SECURITY_HEADERS });
  } catch (err) {
    if (err instanceof SecurityValidationError) return securityErrorResponse(err);
    return Response.json(
      { error: err instanceof Error ? err.message : 'Erro ao sincronizar horário de Brasília.' },
      { status: 500, headers: API_SECURITY_HEADERS },
    );
  }
};
