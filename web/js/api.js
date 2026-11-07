// Backend calls. By default the API is same-origin (FastAPI serves web/).
// Under the static dev server, `web/health` answers instead and says
// `service: "static"`; pass `?api=http://localhost:8000` to reach a backend.

const params = new URLSearchParams(location.search);
export const API_BASE = (params.get('api') ?? '').replace(/\/$/, '');

export async function getHealth() {
  const res = await fetch(`${API_BASE}/health`, { cache: 'no-store' });
  if (!res.ok) throw new Error(`/health returned ${res.status}`);
  return res.json();
}
