import { getSynchronizedBrasiliaTime } from '../../server/timeService.ts';

export default async (): Promise<Response> => {
  try {
    const sync = await getSynchronizedBrasiliaTime(true);
    return Response.json(sync);
  } catch (err) {
    return Response.json(
      { error: err instanceof Error ? err.message : 'Erro ao sincronizar horário de Brasília.' },
      { status: 500 },
    );
  }
};
