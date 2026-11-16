// Robot de Medianoche: corre en GitHub Actions cada 15 minutos.
// 1) junta titulares (GDELT + RSS), 2) la IA los clasifica, 3) busca aviones, 4) escribe data.json
import fs from 'node:fs/promises';

const KEY = process.env.GEMINI_API_KEY;
const MODEL = process.env.GEMINI_MODEL || 'gemini-2.5-flash-lite';
const NOW = Date.now(), H = 3600e3;
const CATS = ['Ciber', 'Finanzas', 'Infraestructura', 'Transporte', 'IA', 'Geopolítica', 'Desastre'];

const leadersCfg = JSON.parse(await fs.readFile('leaders.json', 'utf8'));
let data = { updated: null, events: [], leaders: [] };
try { data = JSON.parse(await fs.readFile('data.json', 'utf8')); } catch {}
const prev = Object.fromEntries((data.leaders || []).map(l => [l.id, l]));

async function get(url, opts = {}) {
  const r = await fetch(url, { ...opts, signal: AbortSignal.timeout(20000),
    headers: { 'user-agent': 'medianoche-bot/1.0 (GitHub Actions)', ...(opts.headers || {}) } });
  if (!r.ok) throw new Error(`${r.status} ${url}`);
  return r;
}
const clean = s => (s || '').replace(/<!\[CDATA\[|\]\]>/g, '').replace(/<[^>]+>/g, '')
  .replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').trim();

// ---------- 1. Fuentes ----------
const RSS = [
  ['BBC', 'https://feeds.bbci.co.uk/news/world/rss.xml'],
  ['BBC Tech', 'https://feeds.bbci.co.uk/news/technology/rss.xml'],
  ['Al Jazeera', 'https://www.aljazeera.com/xml/rss/all.xml'],
  ['NYT', 'https://rss.nytimes.com/services/xml/rss/nyt/World.xml'],
];
async function rss([source, url]) {
  const xml = await (await get(url)).text();
  return [...xml.matchAll(/<item[\s\S]*?<\/item>/g)].map(m => {
    const pick = t => clean((m[0].match(new RegExp(`<${t}[^>]*>([\\s\\S]*?)</${t}>`)) || [])[1]);
    return { title: pick('title'), url: pick('link'), desc: pick('description').slice(0, 300), date: Date.parse(pick('pubDate')) || NOW, source };
  });
}
async function gdelt() {
  const q = '(cyberattack OR hack OR ransomware OR outage OR blackout OR "bank run" OR "ground stop" OR "power grid" OR "artificial intelligence" OR earthquake OR missile OR evacuation) sourcelang:english';
  const url = `https://api.gdeltproject.org/api/v2/doc/doc?query=${encodeURIComponent(q)}&mode=artlist&maxrecords=40&timespan=3h&sort=datedesc&format=json`;
  const j = await (await get(url)).json();
  return (j.articles || []).map(a => {
    const s = a.seendate || '';
    const date = Date.UTC(+s.slice(0, 4), +s.slice(4, 6) - 1, +s.slice(6, 8), +s.slice(9, 11), +s.slice(11, 13)) || NOW;
    return { title: clean(a.title), url: a.url, desc: '', date, source: a.domain };
  });
}

const seen = new Set((data.events || []).map(e => e.url));
const results = await Promise.allSettled([gdelt(), ...RSS.map(rss)]);
results.forEach((r, i) => r.status === 'rejected' && console.log('Fuente falló:', i === 0 ? 'GDELT' : RSS[i - 1][0], r.reason.message));
const titles = new Set();
const candidates = results.flatMap(r => r.status === 'fulfilled' ? r.value : [])
  .filter(c => c.title && c.url && !seen.has(c.url) && NOW - c.date < 6 * H)
  .filter(c => { const k = c.title.toLowerCase().slice(0, 60); if (titles.has(k)) return false; titles.add(k); return true; })
  .sort((a, b) => b.date - a.date).slice(0, 35);
console.log('Titulares nuevos:', candidates.length);

// ---------- 2. Clasificación con IA ----------
async function classify(items) {
  const recent = (data.events || []).slice(0, 20).map(e => '- ' + e.title).join('\n');
  const people = leadersCfg.map(l => `${l.id}: ${l.name}`).join(', ');
  const list = items.map((c, i) => `[${i}] (${c.source}) ${c.title}${c.desc ? ' — ' + c.desc : ''}`).join('\n');
  const prompt = `Sos el editor de "Medianoche", un monitor de riesgo global. Te paso titulares de noticias.

Tarea 1: elegí SOLO los que describen un suceso grave en curso o reciente de alguna de estas categorías: ${CATS.join(', ')}. Ignorá opinión, deportes, espectáculos, política doméstica menor y notas viejas. Si dos titulares cuentan lo mismo, devolvé uno solo. No repitas sucesos que ya están en esta lista:
${recent || '(vacía)'}

Para cada suceso elegido devolvé:
- "i": número del titular
- "cat": una de las categorías
- "sev": gravedad de 1 (menor) a 5 (crisis global)
- "title": título en español, claro, máximo 90 caracteres
- "summary": 1 o 2 oraciones en español con qué pasó y a quién afecta
- "place": lugar principal (ciudad y país)
- "lat", "lon": coordenadas aproximadas de ese lugar
- "affected": cantidad de personas afectadas SOLO si el titular o resumen da un número; si no, null
- "loss": pérdidas en dólares SOLO si se mencionan; si no, null
- "ai": si el suceso tiene relación con inteligencia artificial, explicala en una oración; si no, null
Nunca inventes cifras.

Tarea 2: si algún titular dice dónde está ahora alguna de estas personas (${people}), devolvé en "sightings" objetos con "id", "place", "lat", "lon".

Respondé solo JSON con esta forma: {"events":[...],"sightings":[...]}

Titulares:
${list}`;
  const r = await get(`https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-goog-api-key': KEY },
    body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: prompt }] }],
      generationConfig: { responseMimeType: 'application/json', temperature: 0.2 } }),
  });
  const j = await r.json();
  const text = j.candidates?.[0]?.content?.parts?.map(p => p.text || '').join('') || '{}';
  return JSON.parse(text.replace(/```json|```/g, '').trim());
}

let sightings = [];
if (!KEY) console.log('Falta GEMINI_API_KEY: no se clasifican noticias.');
else if (candidates.length) {
  try {
    const out = await classify(candidates);
    const num = v => (typeof v === 'number' && isFinite(v) && v > 0 ? v : null);
    const fresh = (out.events || []).filter(e => candidates[e.i] && CATS.includes(e.cat)).map(e => {
      const c = candidates[e.i];
      return { id: Buffer.from(c.url).toString('base64url').slice(-16), url: c.url, source: c.source, t: c.date,
        cat: e.cat, sev: Math.min(5, Math.max(1, Math.round(e.sev || 1))), title: String(e.title || c.title).slice(0, 120),
        summary: String(e.summary || ''), place: String(e.place || ''), lat: +e.lat || 0, lon: +e.lon || 0,
        affected: num(e.affected), loss: num(e.loss), ai: e.ai || null };
    });
    console.log('Sucesos nuevos:', fresh.length);
    data.events = [...fresh, ...(data.events || [])];
    sightings = (out.sightings || []).filter(s => leadersCfg.some(l => l.id === s.id) && isFinite(+s.lat) && isFinite(+s.lon));
  } catch (err) { console.log('La IA falló:', err.message); }
}
data.events = (data.events || []).filter(e => NOW - e.t < 48 * H).sort((a, b) => b.t - a.t).slice(0, 60);

// ---------- 3. Aviones ----------
async function findAircraft(hex) {
  for (const url of [`https://opendata.adsb.fi/api/v2/hex/${hex}`, `https://api.adsb.lol/v2/hex/${hex}`]) {
    try {
      const j = await (await get(url)).json();
      const ac = (j.ac || j.aircraft || []).find(a => typeof a.lat === 'number');
      if (ac) return { lat: ac.lat, lon: ac.lon, t: NOW, status: ac.alt_baro === 'ground' || (ac.gs ?? 999) < 50 ? 'tierra' : 'vuelo', callsign: (ac.flight || '').trim() };
      return null;
    } catch (err) { console.log('Avión', hex, err.message); }
  }
  return null;
}

data.leaders = [];
for (const l of leadersCfg) {
  const p = prev[l.id] || {};
  let live = p.live || null;
  for (const hex of l.hex || []) {
    const found = await findAircraft(hex);
    if (found) { live = found; break; }
    await new Promise(r => setTimeout(r, 1100)); // respetar ~1 consulta por segundo
  }
  const s = sightings.find(x => x.id === l.id);
  const news = s ? { place: s.place, lat: +s.lat, lon: +s.lon, t: NOW } : (p.news || null);
  data.leaders.push({ id: l.id, name: l.name, role: l.role, base: l.base, live, news });
}

// ---------- 4. Guardar ----------
data.updated = NOW;
await fs.writeFile('data.json', JSON.stringify(data, null, 1));
console.log('Listo:', data.events.length, 'sucesos guardados.');
