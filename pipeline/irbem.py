"""JSON stdin/stdout worker. No network/OMNI lookups; explicit IGRF internal field.

AP8 MIN and MAX are reported separately. They are climatological model outputs,
not contemporaneous observations or a dose model.
"""
import json
import sys
import math
import contextlib
import ctypes
from datetime import datetime, timezone

with contextlib.redirect_stdout(sys.stderr):
    import numpy as np
    import spacepy
    from spacepy.time import Ticktock
    from spacepy.coordinates import Coords
    from spacepy import irbempy as ib
    # The parent Node process already isolates this worker. Avoid Windows spawn
    # recursively importing a stdin-driven worker in SpacePy's internal pool.
    spacepy.config['ncpus'] = 1

def number(value):
    value = float(np.asarray(value).reshape(-1)[0])
    return value if math.isfinite(value) and value >= 0 else None

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
    return [number(flux[i, 0]) if valid[i] else None for i in range(len(shells))]

points = json.load(sys.stdin)
# SpacePy 0.7 bundles IGRF coefficients valid through 2025.0. IRBEM otherwise
# silently clamps 2026 to the nearest year and prints a Fortran warning.
if any(not (1900 <= datetime.fromtimestamp(p['t'] / 1000, timezone.utc).year < 2025) for p in points):
    json.dump({'samples': [], 'error': 'IGRF in SpacePy 0.7.0 is valid before 2025.0; update coefficients for this date'}, sys.stdout)
    sys.exit(0)
result = []
with contextlib.redirect_stdout(sys.stderr):
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
            row = {'t': point['t'], 'L': shell, 'B': local, 'magLat': float(magnetic_coords.data[i, 1]), 'ap8Min': None, 'ap8Max': None}
            if shell and local and minimum:
                row['ap8Min'] = ap8_min[i]
                row['ap8Max'] = ap8_max[i]
            result.append(row)
json.dump({'samples': result, 'version': 'spacepy/' + spacepy.__version__,
           'model': 'IGRF internal field; AP8 MIN/MAX >10 MeV'}, sys.stdout, allow_nan=False)
