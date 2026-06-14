export type TerrainType =
  | 'none'
  | 'plain'
  | 'mountain'
  | 'snowy_mountain'
  | 'forest'
  | 'desert'
  | 'water'

export interface TerrainConfig {
  label: string
  /** Opaque colour used to fill hexes on the map (translucency is applied once
   *  to the whole terrain layer, so per-hex fills must be solid to avoid seams). */
  color: string
  /** Translucent fill used only for the sidebar swatch preview. */
  fill: string
  stroke: string
  icon: string
}

export const TERRAIN: Record<TerrainType, TerrainConfig> = {
  none: {
    label: 'Clear',
    color: 'transparent',
    fill: 'rgba(0,0,0,0.01)',
    stroke: 'rgba(150,150,150,0.35)',
    icon: '✕',
  },
  plain: {
    label: 'Plain',
    color: 'rgb(130, 210, 100)',
    fill: 'rgba(130, 210, 100, 0.5)',
    stroke: 'rgba(80,160,60,0.6)',
    icon: '~',
  },
  mountain: {
    label: 'Mountain',
    color: 'rgb(130, 100, 70)',
    fill: 'rgba(130, 100, 70, 0.6)',
    stroke: 'rgba(90,70,50,0.7)',
    icon: '^',
  },
  snowy_mountain: {
    label: 'Snowy Mtn',
    color: 'rgb(210, 230, 255)',
    fill: 'rgba(210, 230, 255, 0.65)',
    stroke: 'rgba(140,170,210,0.7)',
    icon: '*',
  },
  forest: {
    label: 'Forest',
    color: 'rgb(30, 110, 50)',
    fill: 'rgba(30, 110, 50, 0.6)',
    stroke: 'rgba(20,80,35,0.7)',
    icon: '#',
  },
  desert: {
    label: 'Desert',
    color: 'rgb(220, 175, 80)',
    fill: 'rgba(220, 175, 80, 0.6)',
    stroke: 'rgba(180,140,50,0.7)',
    icon: '.',
  },
  water: {
    label: 'Water',
    color: 'rgb(60, 120, 210)',
    fill: 'rgba(60, 120, 210, 0.55)',
    stroke: 'rgba(40,90,170,0.65)',
    icon: '~',
  },
}

export type HexMap = Record<string, TerrainType>
