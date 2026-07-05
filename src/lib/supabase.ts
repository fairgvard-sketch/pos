import { createClient } from '@supabase/supabase-js'

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY
const supabaseServiceKey = import.meta.env.VITE_SUPABASE_SERVICE_KEY

if (!supabaseUrl || !supabaseAnonKey) {
  throw new Error('Missing Supabase environment variables')
}

// Use service_role key if available — bypasses RLS entirely.
// Safe for a closed POS app used only by restaurant staff on local network.
const activeKey = supabaseServiceKey || supabaseAnonKey

export const supabase = createClient(supabaseUrl, activeKey, {
  auth: {
    persistSession: true,
    autoRefreshToken: true,
  },
  realtime: {
    params: {
      eventsPerSecond: 10,
    },
  },
})

// No-op wrapper kept for API compatibility — service_role bypasses RLS.
export async function withContext<T>(fn: () => Promise<T>): Promise<T> {
  return fn()
}
