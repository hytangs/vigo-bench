export const ENGINE_COLORS = { VIGO: '#1d7253', 'VIGO-py': '#67a43c', MOTIS: '#cc7621', 'ULTRA-OSM': '#8050bd', R5: '#c04d73', OTP: '#347dd1', Valhalla: '#b49126', R5py: '#795548', GraphHopper: '#258b99' };
const escape = value => String(value).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
export function comparisonSeries(rows, engines, { metric = 'endToEndMs', population = 'common', type = 'all' } = {}) {
  const eligible = rows.filter(row => (type === 'all' || row.odType === type)
    && (population !== 'common' || engines.every(engine => row.engines[engine]?.status === 'ready')));
  return engines.map(engine => ({ engine, color: ENGINE_COLORS[engine] ?? '#666', values: eligible.flatMap(row => {
    const result = row.engines[engine], value = result?.[metric];
    return result?.status !== 'mismatch' && typeof value === 'number' && Number.isFinite(value) && value >= 0 ? [value] : [];
  }).sort((a,b) => a-b) }));
}
export function renderEngineChart(container, legend, rows, engines, options) {
  const series = comparisonSeries(rows, engines, options), plotted = series.filter(row => row.values.length);
  legend.innerHTML = series.map(row => `<span><svg width="10" height="10" aria-hidden="true"><circle cx="5" cy="5" r="5" fill="${row.color}"/></svg>${escape(row.engine)} <small>${row.values.length} queries</small></span>`).join('');
  if (!plotted.length) { container.innerHTML = `<p class="chart-empty">${options.population === 'common' ? 'No shared routed ODs with this timer. Choose “All responses” or run more engines.' : 'No timing samples for this selection.'}</p>`; return; }
  const w=1100,h=310,l=58,r=25,t=22,b=45, max=Math.max(1,...plotted.map(row => row.values.at(-1)));
  const x=v=>l+Math.log1p(v)/Math.log1p(max)*(w-l-r), y=v=>t+(1-v)*(h-t-b);
  const grid=Array.from({length:5},(_,i)=>{
    const q=i/4,tick=Math.expm1(q*Math.log1p(max));
    return `<line x1="${l}" x2="${w-r}" y1="${y(q)}" y2="${y(q)}" stroke="#e2e7e0"/><text x="${l-10}" y="${y(q)+4}" text-anchor="end">${q*100}%</text><text x="${x(tick)}" y="${h-22}" text-anchor="middle">${tick.toLocaleString(undefined,{maximumFractionDigits:2})}</text>`;
  }).join('');
  const paths=plotted.map(row=>{
    const n=row.values.length, stride=Math.max(1,Math.ceil(n/600));
    const points=[[x(0),y(0)],...row.values.flatMap((v,i)=>i%stride===0||i===n-1?[[x(v),y(i/n)],[x(v),y((i+1)/n)]]:[])];
    return `<path d="${points.map((p,i)=>`${i?'L':'M'}${p.join(',')}`).join(' ')}" fill="none" stroke="${row.color}" stroke-width="2.5"><title>${escape(row.engine)} · ${n} queries · median ${row.values[Math.ceil(n/2)-1].toFixed(2)} ms</title></path>`;
  }).join('');
  container.innerHTML=`<svg viewBox="0 0 ${w} ${h}" role="img" aria-label="All engine latency distributions"><desc>Percentage of queries completed within the time on the horizontal axis. Each engine has its own colored line. Time uses a logarithmic scale.</desc>${grid}${paths}<text x="${l}" y="13">Queries completed</text><text x="${w/2}" y="${h-2}" text-anchor="middle">Query time · milliseconds · log scale</text></svg>`;
}
