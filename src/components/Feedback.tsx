export function Feedback({ params }: { params: { fehler?: string; ok?: string } }) {
  if (params.fehler) return <p className="error mb-4" role="alert">{params.fehler}</p>;
  if (params.ok) return <p className="success mb-4" role="status">{params.ok}</p>;
  return null;
}
export type SearchParams = Promise<{ fehler?: string; ok?: string }>;
