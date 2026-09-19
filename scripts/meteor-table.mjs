// Regenerates data/meteor-showers.json: sporadic meteoroid flux (Grün et al. 1985) bounded
// for showers with the published NASA MEO LEO forecasts. Run: npm run meteor:table
import {writeFile} from 'node:fs/promises';
import {grun,earthFactor} from '../pipeline/meteor.mjs';

const ALTITUDE_KM=420;
// MEO reports fluxes to 6.7 J, "the energy capable of penetrating an EVA suit": 3.35e-5 g at 20 km/s.
const MASS_G=3.35e-5;
// Both releases state that at 6.7 J only the Geminids exceed the sporadic baseline, so every
// other shower adds less than 100 %: total <= 2 × sporadic outside the Geminid window.
const SHOWER_BOUND=2;
const GEMINID_MARGIN_MS=7*86400000;
const RELEASES=[
  {year:2024,issued:'2023-11-02T00:00:00Z',url:'https://ntrs.nasa.gov/api/citations/20230015158/downloads/LEO_Forecast_2024.pdf',geminids:'2024-12-14T02:10:00Z'},
  {year:2026,issued:'2025-10-17T00:00:00Z',url:'https://ntrs.nasa.gov/api/citations/20250009524/downloads/LEO_Forecast_2026.pdf',geminids:'2026-12-14T13:00:00Z'}
];

const sporadic=grun(MASS_G)*earthFactor(ALTITUDE_KM);
const iso=t=>new Date(t).toISOString();
const records=RELEASES.flatMap(r=>{
  const peak=Date.parse(r.geminids);
  const common={publishedAt:r.issued,sourceVersion:`NASA MEO LEO forecast ${r.year} (issued ${r.issued.slice(0,10)}) + Grün 1985`,sourceUrl:r.url,
    massThresholdG:MASS_G,altitudeKm:ALTITUDE_KM,sporadicFluxM2Second:sporadic,showerBoundFactor:SHOWER_BOUND,fluxM2Second:sporadic*SHOWER_BOUND};
  return [[Date.UTC(r.year,0,1),peak-GEMINID_MARGIN_MS],[peak+GEMINID_MARGIN_MS,Date.UTC(r.year+1,0,1)]].map(([start,end])=>({start:iso(start),end:iso(end),...common}));
});
const table={schemaVersion:1,
  description:'Верхняя оценка полного метеороидного потока: спорадический фон Грюна (1985, формула и поправки на Землю SPENVIS) для 420 км и массы ≥ 3,35·10⁻⁵ г (6,7 Дж, NASA MEO), умноженный на 2 — по выпускам NASA MEO при этой энергии фон превышают только Геминиды. Окна Геминид (пик ± 7 сут) и годы без выпуска MEO не оцениваются. Генерируется scripts/meteor-table.mjs.',
  records};
await writeFile(new URL('../data/meteor-showers.json',import.meta.url),JSON.stringify(table,null,2)+'\n');
console.log(JSON.stringify({records:records.length,sporadicFluxM2Second:sporadic,fluxM2Second:sporadic*SHOWER_BOUND,hitsPer8hPerM2:sporadic*SHOWER_BOUND*8*3600}));
