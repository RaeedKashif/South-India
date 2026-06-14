// Region + world configuration shared by the generator and the API.
// The grid is generated for the WHOLE WORLD; regions are just named bboxes used
// to serve a slice to the client (today we only surface South Asia).

export const WORLD = {
  // Exclude most of Antarctica; keep a usable global rectangle.
  bbox: { lonMin: -180, latMin: -58, lonMax: 180, latMax: 84 },
  pxPerDeg: 60,
  hexSize: 26, // circumradius in world pixels (≈ resolution)
}

export const REGIONS = {
  south_asia: {
    id: 'south_asia',
    name: 'South Asia',
    bbox: { lonMin: 59.5, latMin: 2.0, lonMax: 98.5, latMax: 39.5 },
  },
}

// Curated colours for the focus countries; everything else gets a generated hue.
const CURATED = {
  PAK: '#7ba05b', IND: '#d9924a', BGD: '#5fa08e', NPL: '#c2685f',
  BTN: '#d4b35e', LKA: '#9a6fa0', AFG: '#b39b78', MDV: '#5b9bd5',
}

function hashHue(s) {
  let h = 0
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0
  return h % 360
}

// Deterministic, muted colour for any country code.
export function colorForIso(iso) {
  if (CURATED[iso]) return CURATED[iso]
  const hue = hashHue(iso || 'XXX')
  return `hsl(${hue}, 38%, 60%)`
}
