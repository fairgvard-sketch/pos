import { supabase } from '../../lib/supabase'

export interface Guest {
  id: string
  name: string
  phone: string
  points: number
  visits: number
  created_at: string
}

export interface GuestVisit {
  id: string
  guest_id: string
  order_id: string
  earned: number
  spent: number
  total_paid: number
  created_at: string
}

export async function lookupGuest(phone: string): Promise<Guest | null> {
  const normalized = phone.replace(/\D/g, '')
  const { data, error } = await supabase
    .from('guests')
    .select('*')
    .or(`phone.eq.${phone},phone.eq.${normalized}`)
    .maybeSingle()

  if (error) throw error
  return data as Guest | null
}

export async function createGuest(name: string, phone: string): Promise<Guest> {
  const { data, error } = await supabase
    .from('guests')
    .insert({ name, phone, points: 0, visits: 0 })
    .select()
    .single()

  if (error) throw error
  return data as Guest
}

export async function applyPoints(
  guestId: string,
  orderId: string,
  pointsSpent: number,
  totalPaid: number
): Promise<void> {
  const earned = Math.floor(totalPaid)

  const { error: visitErr } = await supabase.from('guest_visits').insert({
    guest_id: guestId,
    order_id: orderId,
    earned,
    spent: pointsSpent,
    total_paid: totalPaid,
  })
  if (visitErr) throw visitErr

  const { error: guestErr } = await supabase.rpc('update_guest_points', {
    p_guest_id: guestId,
    p_earned: earned,
    p_spent: pointsSpent,
  })
  if (guestErr) {
    // Fallback: manual update if RPC not deployed yet
    const { data: current } = await supabase
      .from('guests')
      .select('points, visits')
      .eq('id', guestId)
      .single()

    if (current) {
      await supabase
        .from('guests')
        .update({
          points: Math.max(0, current.points + earned - pointsSpent),
          visits: current.visits + 1,
        })
        .eq('id', guestId)
    }
  }
}

export async function fetchGuestVisits(guestId: string): Promise<GuestVisit[]> {
  const { data, error } = await supabase
    .from('guest_visits')
    .select('*')
    .eq('guest_id', guestId)
    .order('created_at', { ascending: false })
    .limit(20)

  if (error) throw error
  return data as GuestVisit[]
}

export async function fetchAllGuests(): Promise<Guest[]> {
  const { data, error } = await supabase
    .from('guests')
    .select('*')
    .order('visits', { ascending: false })

  if (error) throw error
  return data as Guest[]
}
