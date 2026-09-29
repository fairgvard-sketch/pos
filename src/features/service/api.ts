import { supabase } from '../../lib/supabase'
import { currentStaffToken } from '../../store/authStore'
import { getDeviceContext } from '../auth/api'

export type ServiceRequestKind =
  | 'call_waiter'
  | 'water'
  | 'cutlery'
  | 'napkins'
  | 'problem'
  | 'bill'

export type ServiceRequestStatus = 'new' | 'accepted' | 'completed' | 'cancelled'

export interface ServiceRequest {
  id: string
  table_id: string
  table_label: string
  kind: ServiceRequestKind
  status: ServiceRequestStatus
  created_at: string
  accepted_at: string | null
  completed_at: string | null
  accepted_by: string | null
}
/** Active tasks for this POS location; completed history stays in the DB. */
export async function fetchServiceRequests(): Promise<ServiceRequest[]> {
  const ctx = await getDeviceContext()
  if (!ctx?.locationId) throw new Error('Device not bootstrapped')

  const { data, error } = await supabase
    .from('service_requests')
    .select('id, table_id, table_label, kind, status, created_at, accepted_at, completed_at, accepted_by')
    .eq('location_id', ctx.locationId)
    .in('status', ['new', 'accepted'])
    .order('created_at', { ascending: true })
  if (error) throw new Error(error.message)
  return data as ServiceRequest[]
}

export async function setServiceRequestStatus(
  requestId: string,
  status: 'accepted' | 'completed' | 'cancelled',
): Promise<{ id: string; status: ServiceRequestStatus }> {
  const { data, error } = await supabase.rpc('set_service_request_status', {
    p_request_id: requestId,
    p_status: status,
    p_staff_session: currentStaffToken(),
  })
  if (error) throw new Error(error.message)
  return data as { id: string; status: ServiceRequestStatus }
}

let serviceChannelSeq = 0

/** Realtime is primary; callers also keep a slow polling fallback. */
export function subscribeServiceRequests(onChange: () => void) {
  const channel = supabase
    .channel(`service-requests-${++serviceChannelSeq}`)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'service_requests' }, onChange)
    .subscribe()
  return () => { void supabase.removeChannel(channel) }
}
