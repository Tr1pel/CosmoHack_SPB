"""JSON stdin/stdout worker. No network/OMNI lookups; explicit IGRF internal field.

AP8 MIN and MAX are reported separately. They are climatological model outputs,
not contemporaneous observations or a dose model.
"""
import json
import os
import sys
import math
import ctypes
from datetime import datetime, timezone

# IRBEM is Fortran: its warnings go straight to file descriptor 1 and may be
# flushed only at exit, bypassing contextlib.redirect_stdout. Keep fd 1 on
# stderr for the whole process; the JSON protocol uses a private copy of stdout.
protocol = os.fdopen(os.dup(1), 'w', encoding='utf-8')
os.dup2(2, 1)

import numpy as np
import spacepy
from spacepy.time import Ticktock
from spacepy.coordinates import Coords
from spacepy import irbempy as ib
# The parent Node process already isolates this worker. Avoid Windows spawn
# recursively importing a stdin-driven worker in SpacePy's internal pool.
spacepy.config['ncpus'] = 1

def igrf_generation():
    """IRBEM exports get_igrf_version since 2024-03; SpacePy 0.7.0 predates it and ships IGRF-13."""
    for name in ('get_igrf_version_', 'get_igrf_version'):
        routine = getattr(ib.irbemlib, name, None)
        if routine is not None:
            version = ctypes.c_int(0)
            routine(ctypes.byref(version))
            return version.value
    return 13

def spacepy_version():
    """Builds from a git commit report __version__ 'UNRELEASED'; the package metadata keeps the real one."""
    try:
        from importlib.metadata import version
        return version('spacepy')
    except Exception:
        return spacepy.__version__

IGRF = igrf_generation()
# IGRF-n is valid up to epoch 1960 + 5n: IGRF-13 until 2025.0, IGRF-14 until 2030.0.
VALID_UNTIL = 1960 + 5 * IGRF

def reply(value):
    json.dump(value, protocol, allow_nan=False)
    protocol.flush()

def number(value):
    value = float(np.asarray(value).reshape(-1)[0])
    return value if math.isfinite(value) and value >= 0 else None

# IRBEM evaluates AP-8 protons for 1 <= L <= 11 and leaves its fill value wherever the
# model's log-flux map is <= 0, i.e. below 1 cm^-2 s^-1: the loss cone under the mirror
# points or inside the inner edge of the belt (including L < 1 at ISS altitude). In AP-8
# that is "no trapped flux", not an unknown; only L > 11 lies outside the model.
AP8_MAX_L = 11.0

def ap8_value(raw, shell):
    """Return (flux, below_model_floor)."""
    value = float(raw)
    if math.isfinite(value) and value >= 0:
        return value, False
    return (0.0, True) if shell <= AP8_MAX_L else (None, False)

def ap8_batch(local, minimum, shells, which_model):
    """Batch the same pinned IRBEM routine wrapped by SpacePy get_AEP8.

    get_AEP8 allocates a full ntime_max flux buffer for EACH scalar. Calling the
    underlying routine once per batch preserves the model at 30-second cadence
    without hundreds of MB of repeated buffer initialization per orbit minute.
    """
    dims = ib.prep_irbem(omnivals={key: [0, 0] for key in
        ['Kp', 'Dst', 'dens', 'velo', 'Pdyn', 'ByIMF', 'BzIMF',
         'G1', 'G2', 'G3', 'W1', 'W2', 'W3', 'W4', 'W5', 'W6']})
    nt, ne = dims['ntime_max'], dims['nalp_max']
    energies = np.zeros((2, ne), dtype=np.float64, order='F')
    energies[:, 0] = 10
    b = np.zeros(nt, dtype=np.float64)
    l = np.zeros(nt, dtype=np.float64)
    valid = np.isfinite(local) & np.isfinite(minimum) & (minimum > 0) & np.isfinite(shells) & (shells > 0)
    b[:len(shells)] = np.divide(local, minimum, out=np.ones(len(shells)), where=valid)
    l[:len(shells)] = np.where(valid, shells, 1)
    flux = np.empty((nt, ne), dtype=np.float64, order='F')
    ib.irbemlib.get_ae8_ap8_flux(
        ib.int4(len(shells)), ib.int4(which_model), ib.int4(3), ib.int4(1),
        energies.ctypes.data_as(ctypes.POINTER((ib.real8 * 2) * ne)),
        b.ctypes.data_as(ctypes.POINTER(ib.real8 * nt)),
        l.ctypes.data_as(ctypes.POINTER(ib.real8 * nt)),
        flux.ctypes.data_as(ctypes.POINTER((ib.real8 * nt) * ne)))
    return [ap8_value(flux[i, 0], shells[i]) if valid[i] else (None, False) for i in range(len(shells))]

points = json.load(sys.stdin)
# Beyond its coefficients IRBEM silently clamps the year and prints a Fortran
# warning; such a substituted field is never returned.
if any(not (1900 <= datetime.fromtimestamp(p['t'] / 1000, timezone.utc).year < VALID_UNTIL) for p in points):
    reply({'samples': [], 'igrf': IGRF,
           'error': f'IGRF-{IGRF} в установленной SpacePy действителен до {VALID_UNTIL}.0; '
                    'для более поздних дат нужна сборка с новыми коэффициентами (docs/data-pipeline.md)'})
    sys.exit(0)
result = []
# Small batches stay within IRBEM's maximum time-array size.
for offset in range(0, len(points), 256):
    batch = points[offset:offset + 256]
    ticks = Ticktock([p['t'] / 1000 for p in batch], 'UNX')
    coords = Coords([[p['alt'], p['lat'], p['lon']] for p in batch],
                    'GDZ', 'sph', units=['km', 'deg', 'deg'], use_irbem=True)
    coords.ticks = ticks
    magnetic_coords = coords.convert('MAG', 'sph')
    model = ib.get_Lm(ticks, coords, [90], extMag='0', intMag='IGRF')
    shells = np.abs(np.asarray(model['Lm']).reshape(-1))
    local_fields = np.asarray(model['Blocal']).reshape(-1)
    minima = np.asarray(model['Bmin']).reshape(-1)
    ap8_min = ap8_batch(local_fields, minima, shells, 3)
    ap8_max = ap8_batch(local_fields, minima, shells, 4)
    for i, point in enumerate(batch):
        raw_l = float(np.asarray(model['Lm'][i]).reshape(-1)[0])
        shell = abs(raw_l) if math.isfinite(raw_l) else None
        local = number(model['Blocal'][i] if 'Blocal' in model else model['Bmirr'][i])
        minimum = number(model['Bmin'][i])
        row = {'t': point['t'], 'L': shell, 'B': local, 'magLat': float(magnetic_coords.data[i, 1]),
               'ap8Min': None, 'ap8Max': None, 'ap8Floor': None}
        if shell and local and minimum:
            (row['ap8Min'], floor_min), (row['ap8Max'], floor_max) = ap8_min[i], ap8_max[i]
            row['ap8Floor'] = floor_min and floor_max
        result.append(row)
reply({'samples': result, 'igrf': IGRF, 'version': f'spacepy/{spacepy_version()}; IGRF-{IGRF}',
       'model': f'IGRF-{IGRF} internal field; AP8 MIN/MAX >10 MeV'})
