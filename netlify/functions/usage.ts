import { getUsageStats } from '../../server/usageTracker.ts';

export default async (): Promise<Response> => {
  try {
    const usage = await getUsageStats();
    return Response.json(usage);
  } catch (err) {
    return Response.json(
      { error: err instanceof Error ? err.message : 'Erro ao consultar consumo.' },
      { status: 500 },
    );
  }
};
