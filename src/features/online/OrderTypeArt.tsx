import type { PublicOrderType } from './publicApi'

/**
 * Иллюстрации шага «איך תרצו לאכול?»: нейтральные для любого заведения,
 * плоские, в палитре страницы — графит кнопок и тёплые цвета еды (крафт,
 * выпечка, кофе). Вектор: чёткие на любом экране и весят пару килобайт.
 * Фирменные картинки заведения — отдельная будущая настройка.
 */

const INK = '#1f2937'
const INK_SOFT = '#374151'
const KRAFT = '#e3c79e'
const KRAFT_DARK = '#d1b083'
const BAKE = '#e0a458'
const BAKE_DARK = '#c4843a'
const COFFEE = '#8b5e3c'
const WOOD = '#c9a27e'
const LINE = '#d1d5db'
const SHADOW = '#eceef1'

export default function OrderTypeArt({ type }: { type: PublicOrderType }) {
  return (
    <svg viewBox="10 8 100 100" width="100%" height="100%" aria-hidden focusable="false">
      <ellipse cx="60" cy="106" rx="44" ry="5" fill={SHADOW} />
      {type === 'here' ? <EatIn /> : type === 'delivery' ? <Delivery /> : <TakeAway />}
    </svg>
  )
}

/** Пакет с собой: багет из крафтового пакета и стакан кофе с крышкой. */
function TakeAway() {
  return (
    <g>
      {/* багет за пакетом */}
      <g transform="rotate(-16 44 34)">
        <rect x="38" y="12" width="13" height="44" rx="6.5" fill={BAKE} />
        <path d="M41 22l7-3M41 30l7-3M41 38l7-3" stroke={BAKE_DARK} strokeWidth="2" strokeLinecap="round" />
      </g>
      {/* ручка пакета */}
      <path d="M42 46v-7a11 11 0 0 1 22 0v7" fill="none" stroke="#b98d55" strokeWidth="3" strokeLinecap="round" />
      {/* пакет */}
      <path d="M28 46h50l4 58H24z" fill={KRAFT} />
      <path d="M71 46h7l4 58h-8z" fill={KRAFT_DARK} />
      <path d="M28 46h50l.5 6H27.5z" fill={KRAFT_DARK} />
      {/* стакан кофе */}
      <path d="M80 68h24l-3.5 36h-17z" fill="#fff" stroke={LINE} strokeWidth="1.5" strokeLinejoin="round" />
      <path d="M81.3 80h21.4l-1.3 13h-18.8z" fill={COFFEE} />
      <circle cx="92" cy="86.5" r="2.5" fill={KRAFT} />
      <rect x="77" y="61" width="30" height="8" rx="3" fill={INK} />
      <rect x="81" y="56.5" width="22" height="5.5" rx="2.75" fill={INK_SOFT} />
    </g>
  )
}

/** Столик в кафе: круассан на тарелке, чашка кофе на блюдце и стул. */
function EatIn() {
  return (
    <g>
      {/* стул */}
      <path d="M22 104V54a10 10 0 0 1 10-10h3" fill="none" stroke={INK} strokeWidth="3.5" strokeLinecap="round" />
      <path d="M42 84l2 20" stroke={INK} strokeWidth="3.5" strokeLinecap="round" />
      <rect x="19" y="79" width="28" height="6" rx="3" fill={WOOD} />
      {/* столик */}
      <rect x="74" y="72" width="5" height="30" fill={INK} />
      <rect x="62" y="100" width="29" height="5" rx="2.5" fill={INK} />
      <rect x="48" y="66" width="58" height="7" rx="3.5" fill={WOOD} />
      {/* тарелка с круассаном */}
      <ellipse cx="65" cy="64.5" rx="13" ry="3" fill="#fff" stroke={LINE} strokeWidth="1.5" />
      <path d="M54 62c3-9 19-9 22 0-7-3-15-3-22 0z" fill={BAKE} />
      <path d="M60 58.5l2 3M65 57.5v3.5M70 58.5l-2 3" stroke={BAKE_DARK} strokeWidth="1.6" strokeLinecap="round" />
      {/* чашка на блюдце и пар */}
      <ellipse cx="92" cy="64.5" rx="11" ry="2.8" fill="#fff" stroke={LINE} strokeWidth="1.5" />
      <path d="M84.5 52h15v6.5a7.5 5.5 0 0 1-15 0z" fill="#fff" stroke={LINE} strokeWidth="1.5" />
      <path d="M99.5 54a4 3.5 0 0 1 0 7" fill="none" stroke={LINE} strokeWidth="2" strokeLinecap="round" />
      <ellipse cx="92" cy="52" rx="7.5" ry="1.8" fill={COFFEE} />
      <path d="M89 46c-2-2.5 2-4 0-7M95 46c-2-2.5 2-4 0-7" fill="none" stroke="#cbd5e1" strokeWidth="1.8" strokeLinecap="round" />
    </g>
  )
}

/** Доставка: скутер с крафтовой коробкой. */
function Delivery() {
  return (
    <g>
      {/* коробка доставки */}
      <rect x="20" y="50" width="34" height="26" rx="4" fill={KRAFT} />
      <rect x="20" y="50" width="34" height="7" rx="3.5" fill={KRAFT_DARK} />
      <path d="M37 57v19" stroke={KRAFT_DARK} strokeWidth="2.5" />
      {/* корпус и сиденье */}
      <path d="M22 92c0-10 8-16 18-16h14v16z" fill={INK_SOFT} />
      <rect x="40" y="72" width="22" height="6" rx="3" fill={INK} />
      <rect x="40" y="88" width="38" height="6" rx="3" fill={INK_SOFT} />
      {/* рулевая колонка и руль */}
      <path d="M76 91l9-34" stroke={INK_SOFT} strokeWidth="5" strokeLinecap="round" />
      <path d="M79 56h14" stroke={INK} strokeWidth="4" strokeLinecap="round" />
      <path d="M78 96a11 11 0 0 1 21 0" fill="none" stroke={INK_SOFT} strokeWidth="3" strokeLinecap="round" />
      {/* колёса */}
      <circle cx="34" cy="97" r="9" fill={INK} />
      <circle cx="34" cy="97" r="3.5" fill="#9ca3af" />
      <circle cx="88" cy="97" r="9" fill={INK} />
      <circle cx="88" cy="97" r="3.5" fill="#9ca3af" />
    </g>
  )
}
