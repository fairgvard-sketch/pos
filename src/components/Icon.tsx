import ordersOutline from '../assets/icons/orders.svg?raw'
import menuOutline from '../assets/icons/menu.svg?raw'
import analyticsOutline from '../assets/icons/analytics.svg?raw'
import settingsOutline from '../assets/icons/settings.svg?raw'
import customersOutline from '../assets/icons/customers.svg?raw'

import ordersDark from '../assets/icons/active/orders-dark.svg?raw'
import menuDark from '../assets/icons/active/menu-dark.svg?raw'
import analyticsDark from '../assets/icons/active/analytics-dark.svg?raw'
import settingsDark from '../assets/icons/active/settings-dark.svg?raw'
import customersDark from '../assets/icons/active/customers-dark.svg?raw'

export type IconName = 'orders' | 'menu' | 'analytics' | 'settings' | 'customers'

const outline: Record<IconName, string> = {
  orders: ordersOutline,
  menu: menuOutline,
  analytics: analyticsOutline,
  settings: settingsOutline,
  customers: customersOutline,
}

const active: Record<IconName, string> = {
  orders: ordersDark,
  menu: menuDark,
  analytics: analyticsDark,
  settings: settingsDark,
  customers: customersDark,
}

interface Props {
  name: IconName
  isActive?: boolean
  size?: number
  className?: string
}

export default function Icon({ name, isActive = false, size = 20, className = '' }: Props) {
  const raw = isActive ? active[name] : outline[name]
  // Заменяем width/height на нужный размер
  const svg = raw
    .replace(/width="24"/, `width="${size}"`)
    .replace(/height="24"/, `height="${size}"`)

  return (
    <span
      className={className}
      style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }}
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  )
}
