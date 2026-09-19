"""Import actual GOES SGPS L2 avg1m schema. Does not invent SWPC integral channels.

Usage: python pipeline/import_netcdf.py FILE.nc OUTPUT.json
Then: npm run pipeline:import -- records OUTPUT.json
"""
import hashlib
import json
import math
import sys
from datetime import datetime, timezone, timedelta
from pathlib import Path
import numpy as np
from netCDF4 import Dataset, num2date

source, output = map(Path, sys.argv[1:3])
version = hashlib.sha256(source.read_bytes()).hexdigest()
fetched = datetime.now(timezone.utc).isoformat().replace('+00:00', 'Z')
records = []
with Dataset(source) as data:
    satellite = str(data.platform)
    if not satellite.startswith('g'):
        raise ValueError('Expected explicit GOES satellite platform')
    times = num2date(data['time'][:], data['time'].units,
                    only_use_cftime_datetimes=False, only_use_python_datetimes=True)
    if data['AvgIntProtonFlux'].dimensions != ('time', 'sensor_units'):
        raise ValueError('Unsupported integral channel axes')
    if data['AvgDiffProtonFlux'].dimensions != ('time', 'sensor_units', 'diff_channels'):
        raise ValueError('Unsupported differential channel axes')
    if data['AvgIntProtonFlux'].units != 'protons/(cm^2 sr s)' or data['AvgDiffProtonFlux'].units != 'protons/(cm^2 sr keV s)':
        raise ValueError('Unsupported proton flux units')
    # Materialize each compressed variable once, not once per channel/sample.
    arrays = {name: variable[:] for name, variable in data.variables.items()}
    for ti, time in enumerate(times):
        # Product timestamps identify the START of a one-minute averaging bin.
        measured = (time + timedelta(minutes=1)).replace(tzinfo=timezone.utc).isoformat().replace('+00:00', 'Z')
        for sensor in range(2):
            instrument = f'{satellite}/SGPS/{"-X" if sensor == 0 else "+X"}'
            for kind, count in [('Int', 1), ('Diff', data['AvgDiffProtonFlux'].shape[2])]:
                for channel in range(count):
                    index = (ti, sensor) if kind == 'Int' else (ti, sensor, channel)
                    raw = arrays[f'Avg{kind}ProtonFlux'][index]
                    value = None if np.ma.is_masked(raw) else float(raw)
                    valid_count = arrays[f'{kind}ValidL1bSamplesInAvg'][index]
                    flags = [arrays[f'{kind}DQF{x}Sum'][index] for x in ['dtc', 'oob', 'err']]
                    ignored = arrays[f'{kind}ProtonIgnoredL1bDQFs'][index]
                    q = 'ok'
                    if value is None or not math.isfinite(value) or value < 0:
                        value, q = None, 'fill'
                    elif np.ma.is_masked(valid_count) or valid_count <= 0 or any(np.ma.is_masked(x) or x != 0 for x in flags) or np.ma.is_masked(ignored) or ignored != 0:
                        q = 'quality'
                    energy = float(arrays['IntegralProtonEffectiveEnergy'][sensor] if kind == 'Int'
                                   else arrays['DiffProtonEffectiveEnergy'][sensor, channel]) / 1000
                    records.append({
                        'sourceId': 'noaa.swpc', 'sourceVersion': version,
                        'seriesId': f'goes.sgps.{"integral" if kind == "Int" else "differential"}.{energy:g}',
                        'instrument': instrument, 'satellite': satellite,
                        'measuredAt': measured, 'publishedAt': None, 'fetchedAt': fetched,
                        'provenance': 'observation', 'quantity': 'proton_integral_flux' if kind == 'Int' else 'proton_differential_flux',
                        'energy': energy, 'unit': 'pfu' if kind == 'Int' else 'cm^-2 s^-1 sr^-1 keV^-1',
                        'value': value, 'q': q, 'cadenceMinutes': 1, 'maxAgeMinutes': 15,
                        'interpolation': 'linear',
                        'payload': {'file': source.name, 'sensorIndex': sensor, 'channelIndex': channel,
                                    'yawFlip': int(arrays['yaw_flip_flag'][ti]), 'intervalStart': str(time),
                                    'fileCreatedAt': str(data.date_created),
                                    'limitation': 'file creation time is not operational publication time'}
                    })
output.write_text(json.dumps(records, allow_nan=False), encoding='utf-8')
print(json.dumps({'records': len(records), 'satellite': satellite, 'sha256': version, 'output': str(output)}))
