// Real init/capture/flush lifecycle, no direct confirmTelemetryContext calls.
// The real SDK forms requests; fetch and Auth events are entirely synthetic.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
type Session = { access_token: string; user: { id: string; app_metadata: { org_id: string; location_id: string } } }
const state = vi.hoisted(() => ({
  session: null as Session | null,
  online: true,
  listeners: new Set<(event: string, session: Session | null) => void>(),
  requests: [] as Array<{ authorization: string | null; body: string }>,
}))
vi.mock('./supabase', async () => {
  const { createClient } = await import('@supabase/supabase-js')
  const client = createClient('https://synthetic.example.test', 'synthetic-anon', {
    accessToken: async () => state.session?.access_token ?? null,
    global: { fetch: async (_url, init) => {
      state.requests.push({authorization:new Headers(init?.headers).get('Authorization'),body:String(init?.body)})
      return new Response('1', {status:200,headers:{'Content-Type':'application/json'}})
    } },
  })
  return {supabase:{
    auth:{getSession:async()=>({data:{session:state.session}}),
      onAuthStateChange(fn:(event:string,session:Session|null)=>void) {
        state.listeners.add(fn)
        fn('INITIAL_SESSION',state.session)
        return {data:{subscription:{unsubscribe(){state.listeners.delete(fn)}}}}
      }},
    rpc:client.rpc.bind(client),
  }}
})
vi.mock('./deviceSync',()=>({deviceUuid:()=>'00000000-0000-4000-8000-00000000dead'}))
vi.mock('./offline/net',()=>({isOnline:()=>state.online,useNetStore:{subscribe:()=>()=>{}}}))
vi.mock('./offline/outboxStore',()=>({useOutboxStore:{getState:()=>({ops:[]})},pendingOpsCount:()=>0,hasFailedOps:()=>false}))
vi.mock('./androidBridge',()=>({bridgeVersion:()=>3}))
import {initTelemetry,captureMessage,flushTelemetry,__resetTelemetryForTests} from './telemetry'
import {CTX_KEY,identityOf,newContext,writeContext} from './telemetry-context'
const session=(name:'A'|'B'):Session=>({access_token:`synthetic-token-${name}`,user:{
  id:name==='A'?'10000000-0000-4000-8000-000000000001':'10000000-0000-4000-8000-000000000002',
  app_metadata:{org_id:`synthetic-org-${name}`,location_id:`synthetic-location-${name}`},
}})
async function settle(){for(let i=0;i<15;i++)await Promise.resolve()}
async function emit(event:string,value:Session|null){
  state.session=value
  for(const listener of state.listeners)listener(event,value)
  await settle()
}
beforeEach(async()=>{
  vi.useFakeTimers();localStorage.clear();state.requests=[];state.listeners.clear()
  state.session=session('A');state.online=true;__resetTelemetryForTests()
  initTelemetry();await settle()
})
afterEach(()=>{vi.clearAllTimers();vi.useRealTimers()})
describe('F6.1-R1 actual Auth lifecycle wiring',()=>{
  it('logout retires the old generation even offline and without a flush during logout',async()=>{
    state.online=false;captureMessage('window','QA_prior_login_event')
    await emit('SIGNED_OUT',null)
    await emit('SIGNED_IN',session('A'))
    state.online=true;await flushTelemetry()
    expect(JSON.stringify(state.requests)).not.toContain('QA_prior_login_event')
  })
  it('B events cannot be sent as A when accounts switch before the next scheduled flush',async()=>{
    state.online=false
    await emit('SIGNED_OUT',null);await emit('SIGNED_IN',session('B'))
    captureMessage('window','QA_private_B_event')
    await emit('SIGNED_OUT',null);await emit('SIGNED_IN',session('A'))
    state.online=true;await flushTelemetry()
    const wrong=state.requests.filter(r=>r.authorization==='Bearer synthetic-token-A'&&r.body.includes('QA_private_B_event'))
    expect(wrong).toHaveLength(0)
  })
  it('current context still captures and sends after the normal init entry point',async()=>{
    captureMessage('window','QA_current_event');await flushTelemetry()
    expect(state.requests.some(r=>r.authorization==='Bearer synthetic-token-A'&&r.body.includes('QA_current_event'))).toBe(true)
  })
  it('shared storage changed by B cannot label a capture still running under A as B',()=>{
    // A second tab has legitimately confirmed B in the shared context key.
    // This tab has not received the Auth event yet and still runs under A.
    const contextB=newContext(identityOf(session('B'))!)
    const oldValue=localStorage.getItem(CTX_KEY)
    writeContext(contextB)
    window.dispatchEvent(new StorageEvent('storage',{
      key:CTX_KEY,oldValue,newValue:localStorage.getItem(CTX_KEY),storageArea:localStorage,
    }))
    captureMessage('window','QA_still_A_event')
    const queue=JSON.parse(localStorage.getItem('kassa-telemetry')??'[]') as Array<{ctx:string;message:string}>
    expect(queue.some(e=>e.ctx===contextB.gen&&e.message.includes('QA_still_A_event'))).toBe(false)
  })
})
