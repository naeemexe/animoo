// Backend calls. By default the API is same-origin (FastAPI serves web/).
// Under the static dev server, `web/health` answers instead and says
// `service: "static"`; pass `?api=http://localhost:8000` to reach a backend.

// Flags can sit before the hash (`/?fast#movie`) or after it (`#movie?autoplay&fast`).
export const urlParams = new URLSearchParams(
  [location.search.slice(1), location.hash.split('?')[1] ?? ''].filter(Boolean).join('&'));
const params = urlParams;
export const API_BASE = (params.get('api') ?? '').replace(/\/$/, '');

export async function getHealth() {
  const res = await fetch(`${API_BASE}/health`, { cache: 'no-store' });
  if (!res.ok) throw new Error(`/health returned ${res.status}`);
  return res.json();
}
