// Sporadic meteoroid environment, SPENVIS "Meteoroid and debris models".
// Grün et al. (1985) interplanetary flux at 1 AU: particles of mass >= m (g) on a randomly
// oriented plate, m^-2 s^-1 (§2.1.2).
export const grun=m=>(2.2e3*m**0.306+15)**-4.38+1.3e-9*(m+1e11*m**2+1e27*m**4)**-0.36+1.3e-16*(m+1e6*m**2)**-0.85;
// Earth shielding ξ = (1 + cos θ)/2 with sin θ = (R+100)/(R+h) and gravitational focusing
// G = 1 + (R+100)/(R+h), R = 6378 km (§2.1.3).
export function earthFactor(altitudeKm){const s=(6378+100)/(6378+altitudeKm);return 0.5*(1+Math.sqrt(1-s*s))*(1+s);}
