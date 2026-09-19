"""Historical GOES SGPS integral proton fluxes from the NCEI L2 archive.

SWPC's operational integral channels (>=10 ... >=500 MeV) are not archived for GOES-R.
They are reconstructed from the L2 5-minute averages: a piecewise power-law differential
spectrum through the effective energies of channels P1-P10, continued to 500 MeV with the
P9-P10 slope, plus the measured P11 >500 MeV integral channel. The east- and west-looking
sensors are combined by their maximum: a conservative value, never an average.

Checked against SWPC (docs/data-pipeline.md): GOES-16 on 10.05.2024 gives >=10 MeV
201 pfu at 17:45 UTC (SWPC: 207 pfu) and a >=100 MeV peak of 5.7 pfu (SWPC: 7 pfu);
quiet GOES-18 days 13-18.09.2026 are 1.3-2x above SWPC because of the background in the
differential channels, i.e. the reconstruction errs on the high side.

Usage: python pipeline/goes_history.py --from 2024-05-01 --to 2024-06-30 [--satellite 16]
Then:  npm run pipeline:import -- records local/goes-history.json
"""
import argparse
import hashlib
import http.client
import json
import math
import re
import sys
import time
import urllib.request
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

ARCHIVE = ('https://data.ngdc.noaa.gov/platforms/solar-space-observing-satellites/goes/'
           'goes{sat}/l2/data/{product}/{year:04d}/{month:02d}/')
THRESHOLDS_MEV = [10, 30, 50, 60, 100, 500]
TOP_KEV = 500000.0


def segment_integral(e1, f1, e2, f2, a, b):
    """Integral of the differential flux over [a, b] inside the segment through (e1,f1), (e2,f2)."""
    if b <= a:
        return 0.0
    if f1 > 0 and f2 > 0:
        g = math.log(f2 / f1) / math.log(e2 / e1)
        if abs(g + 1) < 1e-9:
            return f1 * e1 * math.log(b / a)
        return f1 * e1 / (g + 1) * ((b / e1) ** (g + 1) - (a / e1) ** (g + 1))
    # A channel without counts has no power law: interpolate linearly instead.
    at = lambda e: f1 + (f2 - f1) * (e - e1) / (e2 - e1)
    return (at(a) + at(b)) / 2 * (b - a)


def integral_flux(effective_kev, flux, p11, threshold_kev):
    """J(>=E) in pfu: differential fluxes 1/(cm2 sr keV s) at effective energies plus P11 (pfu)."""
    if threshold_kev >= TOP_KEV:
        return p11
    points = sorted(zip(effective_kev, flux))
    (ea, fa), (eb, fb) = points[-2], points[-1]
    # Continue the last measured slope from the last effective energy up to 500 MeV.
    if fa > 0 and fb > 0:
        slope = math.log(fb / fa) / math.log(eb / ea)
        points.append((TOP_KEV, fb * (TOP_KEV / eb) ** slope))
    else:
        points.append((TOP_KEV, fb))
    total = p11
    for (e1, f1), (e2, f2) in zip(points, points[1:]):
        total += segment_integral(e1, f1, e2, f2, max(e1, threshold_kev), e2)
    return total


def valid_mask(data, prefix, flux):
    """Dead-time and out-of-band contamination invalidate an average. The 'dynamic error'
    flag marks noisy 1-s samples at low counts (set for most quiet-time seconds) and does not."""
    import numpy as np
    ok = ~np.ma.getmaskarray(flux) & (np.ma.filled(flux, -1) >= 0)
    ok &= np.ma.filled(data[f'{prefix}ValidL1bSamplesInAvg'][:], 0) > 0
    for flag in ('dtc', 'oob'):
        ok &= np.ma.filled(data[f'{prefix}DQF{flag}Sum'][:], 1) == 0
    ignored = 'DiffProtonIgnoredL1bDQFs' if prefix == 'Diff' else 'IntProtonIgnoredL1bDQFs'
    ok &= np.ma.filled(data[ignored][:], 1) == 0
    return ok


def records_from_file(path, fetched):
    import numpy as np
    from netCDF4 import Dataset, num2date
    version = hashlib.sha256(path.read_bytes()).hexdigest()
    records = []
    with Dataset(path) as data:
        satellite = str(data.platform)
        if not satellite.startswith('g'):
            raise ValueError('Expected explicit GOES satellite platform')
        if data['AvgDiffProtonFlux'].units != 'protons/(cm^2 sr keV s)' or data['AvgIntProtonFlux'].units != 'protons/(cm^2 sr s)':
            raise ValueError('Unsupported proton flux units')
        step = round(float(np.nanmedian(np.diff(np.ma.filled(data['time'][:].astype(float), np.nan))))) // 60 or 1
        times = num2date(data['time'][:], data['time'].units,
                         only_use_cftime_datetimes=False, only_use_python_datetimes=True)
        diff, integ = data['AvgDiffProtonFlux'][:], data['AvgIntProtonFlux'][:]
        diff_ok, int_ok = valid_mask(data, 'Diff', diff), valid_mask(data, 'Int', integ)
        effective = np.asarray(data['DiffProtonEffectiveEnergy'][:], dtype=float)
        diff, integ = np.ma.filled(diff, np.nan).astype(float), np.ma.filled(integ, np.nan).astype(float)
        for ti, start in enumerate(times):
            # Timestamps mark the START of the averaging bin; t is its end.
            measured = (start + timedelta(minutes=step)).replace(tzinfo=timezone.utc).isoformat().replace('+00:00', 'Z')
            sensors = [s for s in range(diff.shape[1]) if diff_ok[ti, s].all() and int_ok[ti, s]]
            for energy in THRESHOLDS_MEV:
                values = [integral_flux(effective[s], diff[ti, s], integ[ti, s], energy * 1000) for s in sensors]
                value = float(f'{max(values):.5g}') if values else None
                records.append({
                    'sourceId': 'noaa.swpc', 'sourceVersion': version, 'adapterVersion': 3,
                    'fetchedAt': fetched, 'publishedAt': None, 'provenance': 'own_computation',
                    'seriesId': f'goes.sgps.p{energy}', 'instrument': f'{satellite}/SGPS', 'satellite': satellite,
                    'measuredAt': measured, 'quantity': 'proton_integral_flux', 'energy': energy, 'unit': 'pfu',
                    'value': value, 'q': 'ok' if values else 'fill', 'cadenceMinutes': step, 'maxAgeMinutes': 15,
                    'interpolation': 'linear'})
    return records


def log(message):
    print(message, file=sys.stderr, flush=True)


def fetch(url, attempts=4, timeout=30):
    """GET with retries: the archive server now and then stalls a connection."""
    for attempt in range(1, attempts + 1):
        try:
            request = urllib.request.Request(url, headers={'User-Agent': 'CosmoHack-research/2.0'})
            with urllib.request.urlopen(request, timeout=timeout) as response:
                return response.read()
        except (OSError, http.client.HTTPException) as error:
            if attempt == attempts:
                raise RuntimeError(f'{url}: {error}') from error
            log(f'  повтор {attempt}/{attempts - 1} через {2 * attempt} с: {error}')
            time.sleep(2 * attempt)


def download(url, path):
    started = time.monotonic()
    data = fetch(url)
    temp = path.with_suffix('.part')
    temp.write_bytes(data)
    temp.rename(path)
    return len(data), time.monotonic() - started


def archive_files(satellite, product, first, last, cache):
    """Newest file version per day, downloaded once into the cache directory."""
    cache.mkdir(parents=True, exist_ok=True)
    days = [first + timedelta(n) for n in range((last - first).days + 1)]
    wanted = {}
    for year, month in sorted({(d.year, d.month) for d in days}):
        url = ARCHIVE.format(sat=satellite, product=product, year=year, month=month)
        try:
            listing = fetch(url).decode('utf-8', 'replace')
        except RuntimeError as error:
            sys.exit(f'список файлов архива недоступен ({error}); проверьте доступ к data.ngdc.noaa.gov и запустите ещё раз')
        for name, stamp, version in re.findall(rf'(sci_{product}_g{satellite}_d(\d{{8}})_v([\d-]+)\.nc)', listing):
            day = datetime.strptime(stamp, '%Y%m%d').date()
            key = tuple(int(x) for x in version.split('-'))
            if first <= day <= last and (day not in wanted or key > wanted[day][0]):
                wanted[day] = (key, url + name, name)
    missing = [d.isoformat() for d in days if d not in wanted]
    if missing:
        log(f'нет в архиве: {", ".join(missing)}')
    paths = [cache / wanted[day][2] for day in sorted(wanted)]
    todo = [(day, wanted[day][1], cache / wanted[day][2]) for day in sorted(wanted) if not (cache / wanted[day][2]).exists()]
    log(f'файлов за период: {len(paths)}, уже скачано: {len(paths) - len(todo)}, скачать: {len(todo)}')
    failed = []
    with ThreadPoolExecutor(max_workers=4) as pool:
        jobs = {pool.submit(download, url, path): day for day, url, path in todo}
        for done, job in enumerate(as_completed(jobs), 1):
            try:
                size, seconds = job.result()
                log(f'[{done}/{len(todo)}] {jobs[job]} · {size / 1e6:.2f} МБ · {seconds:.1f} с')
            except RuntimeError as error:
                failed.append(jobs[job].isoformat())
                log(f'[{done}/{len(todo)}] {jobs[job]} не скачан: {error}')
    if failed:
        log(f'не скачаны: {", ".join(sorted(failed))}. Запустите ещё раз: скачанные файлы сохранены в {cache}.')
        sys.exit(1)
    return paths


def selftest():
    """A pure power law must integrate exactly, including the continuation to 500 MeV."""
    effective = [1377.4, 2090.5, 2777.7, 4693.8, 8015.0, 16457.9, 30800.8, 54387.7, 90799.0,
                 108573.5, 128238.1, 196774.0, 333922.2]
    a, g = 1e6, -3.0
    flux = [a * e ** g for e in effective]
    p11 = a * TOP_KEV ** (g + 1) / -(g + 1)
    for energy in THRESHOLDS_MEV:
        exact = a * (energy * 1000) ** (g + 1) / -(g + 1)
        got = integral_flux(effective, flux, p11, energy * 1000)
        assert abs(got - exact) / exact < 1e-9, (energy, got, exact)
    print(json.dumps({'selftest': 'ok'}))


def main():
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument('files', nargs='*', type=Path, help='local L2 NetCDF files instead of downloading')
    parser.add_argument('--from', dest='first', type=date.fromisoformat)
    parser.add_argument('--to', dest='last', type=date.fromisoformat)
    parser.add_argument('--satellite', type=int, default=16)
    parser.add_argument('--product', default='sgps-l2-avg5m')
    parser.add_argument('--cache', type=Path, default=Path('local/goes-l2'))
    parser.add_argument('--out', type=Path, default=Path('local/goes-history.json'))
    parser.add_argument('--selftest', action='store_true')
    args = parser.parse_args()
    if args.selftest:
        return selftest()
    if not args.files and not (args.first and args.last):
        parser.error('give L2 files or --from and --to')
    try:
        import netCDF4  # checked before anything is downloaded
    except ImportError:
        sys.exit('нужен netCDF4: .venv/bin/pip install -r requirements-server.txt')
    paths = args.files or archive_files(args.satellite, args.product, args.first, args.last, args.cache)
    fetched = datetime.now(timezone.utc).isoformat().replace('+00:00', 'Z')
    records = []
    for done, path in enumerate(paths, 1):
        records += records_from_file(path, fetched)
        if done % 10 == 0 or done == len(paths):
            log(f'обработано файлов: {done}/{len(paths)}')
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(records, allow_nan=False, separators=(',', ':')), encoding='utf-8')
    valid = sum(r['q'] == 'ok' for r in records)
    print(json.dumps({'files': len(paths), 'records': len(records), 'valid': valid, 'output': str(args.out)}))


if __name__ == '__main__':
    main()
