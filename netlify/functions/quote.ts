import { authErrorResponse, verifyFirebaseIdTokenHeader } from '../../server/firebaseAuth.ts';
import { fetchMarketQuote } from '../../server/marketData.ts';

export default async (req: Request): Promise<Response> => {
  try {
    await verifyFirebaseIdTokenHeader(req.headers.get('authorization'));
  } catch (err) {
    return authErrorResponse(err);
  }

  const url = new URL(req.url);
  const symbol = url.searchParams.get('symbol') || '';
  const timeframe = url.searchParams.get('timeframe') || '15m';

  if (!symbol.trim()) {
    return Response.json({ error: 'Parâmetro symbol é obrigatório.' }, { status: 400 });
  }

  try {
    const quote = await fetchMarketQuote(symbol, timeframe);
    return Response.json(quote);
  } catch (err) {
    return Response.json(
      { error: err instanceof Error ? err.message : 'Erro ao consultar cotação.' },
      { status: 500 },
    );
  }
};
