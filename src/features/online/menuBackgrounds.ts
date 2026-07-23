export const MENU_BACKGROUND_PRESETS = [
  {
    id: 'ivory',
    marker: 'ivory-food',
    url: '/menu-backgrounds/ivory-food.webp',
    labels: { ru: 'Слоновая кость', he: 'שנהב' },
    themeColor: '#eee4cf',
    darkUi: false,
  },
  {
    id: 'sage',
    marker: 'sage-food',
    url: '/menu-backgrounds/sage-food.webp',
    labels: { ru: 'Шалфей', he: 'מרווה' },
    themeColor: '#c8d2b4',
    darkUi: false,
  },
  {
    id: 'coral',
    marker: 'coral-food',
    url: '/menu-backgrounds/coral-food.webp',
    labels: { ru: 'Коралл', he: 'קורל' },
    themeColor: '#ef6f4f',
    darkUi: false,
  },
  {
    id: 'midnight',
    marker: 'midnight-food',
    url: '/menu-backgrounds/midnight-food.webp',
    labels: { ru: 'Ночь', he: 'לילה' },
    themeColor: '#151515',
    darkUi: true,
  },
  {
    id: 'mustard',
    marker: 'mustard-food',
    url: '/menu-backgrounds/mustard-food.webp',
    labels: { ru: 'Горчица', he: 'חרדל' },
    themeColor: '#e9b94c',
    darkUi: false,
  },
  {
    id: 'mint',
    marker: 'mint-herb-food',
    url: '/menu-backgrounds/mint-herb-food.webp',
    labels: { ru: 'Мята', he: 'נענע' },
    themeColor: '#c9ddd2',
    darkUi: false,
  },
  {
    id: 'apricot',
    marker: 'apricot-bistro-food',
    url: '/menu-backgrounds/apricot-bistro-food.webp',
    labels: { ru: 'Абрикос', he: 'משמש' },
    themeColor: '#ef9a72',
    darkUi: false,
  },
  {
    id: 'plum',
    marker: 'plum-evening-food',
    url: '/menu-backgrounds/plum-evening-food.webp',
    labels: { ru: 'Слива', he: 'שזיף' },
    themeColor: '#241821',
    darkUi: true,
  },
] as const

export function findMenuBackgroundPreset(url: string | null | undefined) {
  if (!url) return undefined
  return MENU_BACKGROUND_PRESETS.find((preset) => url.includes(preset.marker))
}

export function resolveMenuBackgroundUrl(url: string | null | undefined): string | null {
  return findMenuBackgroundPreset(url)?.url ?? url ?? null
}

export function menuBackgroundThemeColor(url: string): string {
  return findMenuBackgroundPreset(url)?.themeColor ?? '#f8f9fb'
}

export function menuBackgroundUsesDarkUi(url: string): boolean {
  return findMenuBackgroundPreset(url)?.darkUi ?? false
}
