// OnePass Worker adapter: signed identity, role projection and optional provisioning.
import { APP_ROLES, type AppRole } from './auth';

export interface OnePassEnv {
  DB: D1Database;
  ONEPASS_ENABLED?: string;
  ONEPASS_ORIGIN?: string;
  ONEPASS_CLIENT_ID?: string;
  ONEPASS_CLIENT_SECRET?: string;
  ONEPASS_REDIRECT_URI?: string;
  ONEPASS_PRODUCT_CODE?: string;
  ONEPASS_ENVIRONMENT?: string;
  ONEPASS_INSTANCE_ID?: string;
  ONEPASS_ORG_ID?: string;
  ONEPASS_DELIVERY_KEY_ID?: string;
  ONEPASS_DELIVERY_SECRET?: string;
  ONEPASS_MANAGED_MEMBER_ROLES?: 'staging' | '1';
  ONEPASS_REQUIRED_EMAIL_DOMAIN?: string;
}

export interface OnePassIdentity {
  active: true;
  access_model?: 'subscription' | 'unlimited';
  session_id: string;
  expires_at: string;
  application_user_id: string;
  user: {id: string; name: string; email?: string; email_verified?: boolean};
  membership: {id: string; org_id: string; role: string; org_role?: string; application_roles?: AppRole[]};
}

const uuid = (value: unknown): value is string =>
  typeof value === 'string' && /^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(value);
const token = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9_-]{43}$/.test(value);
const encoder = new TextEncoder();
const hex = (bytes: ArrayBuffer) => Array.from(new Uint8Array(bytes), n => n.toString(16).padStart(2,'0')).join('');
const base64url = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replace(/=+$/,'').replace(/\+/g,'-').replace(/\//g,'_');
const random = () => base64url(crypto.getRandomValues(new Uint8Array(32)));
const hash = (value: string) => crypto.subtle.digest('SHA-256',encoder.encode(value));
const forbidden = () => new Response('OnePass 授权无效',{status:403,headers:{'cache-control':'no-store'}});
const linkRequired = () => Response.json({error:{code:'ACCOUNT_LINK_REQUIRED'}},{status:409,headers:{'cache-control':'no-store'}});
const unavailable = () => new Response('OnePass 暂不可用',{status:503,headers:{'cache-control':'no-store'}});
export const onePassEnabled = (env:OnePassEnv) => env.ONEPASS_ENABLED==='1';
export const onePassOwnsMemberManagement = (env: OnePassEnv) =>
  env.ONEPASS_MANAGED_MEMBER_ROLES === 'staging' || env.ONEPASS_MANAGED_MEMBER_ROLES === '1';

function isApplicationRoles(value: unknown): value is AppRole[] {
  return Array.isArray(value) && value.length <= APP_ROLES.length &&
    new Set(value).size === value.length && value.every(role => APP_ROLES.includes(role));
}

function encodeApplicationRoles(roles: AppRole[] | undefined): string | null {
  return roles === undefined ? null : JSON.stringify([...roles].sort());
}

function config(env:OnePassEnv) {
  if(!onePassEnabled(env)||!env.ONEPASS_ORIGIN||!env.ONEPASS_REDIRECT_URI||!env.ONEPASS_CLIENT_ID||!token(env.ONEPASS_CLIENT_SECRET)||
    !env.ONEPASS_PRODUCT_CODE||!['test','production'].includes(env.ONEPASS_ENVIRONMENT??'')||!uuid(env.ONEPASS_INSTANCE_ID)||
    !env.ONEPASS_ORG_ID||!env.ONEPASS_DELIVERY_KEY_ID||!env.ONEPASS_DELIVERY_SECRET) throw Error('OnePass configuration incomplete');
  const origin=new URL(env.ONEPASS_ORIGIN), redirect=new URL(env.ONEPASS_REDIRECT_URI);
  for(const url of [origin,redirect]){
    const local=env.ONEPASS_ENVIRONMENT==='test'&&['localhost','127.0.0.1','[::1]'].includes(url.hostname);
    if((url.protocol!=='https:'&&!(local&&url.protocol==='http:'))||url.username||url.password||url.hash||url.search) throw Error('OnePass URL invalid');
  }
  if(origin.pathname!=='/'||redirect.pathname!=='/auth/onepass/callback') throw Error('OnePass URL invalid');
  const raw=Uint8Array.from(atob(env.ONEPASS_DELIVERY_SECRET),c=>c.charCodeAt(0));
  if(raw.length!==32) throw Error('OnePass signing key invalid');
  return {origin,redirect,raw,clientId:env.ONEPASS_CLIENT_ID,clientSecret:env.ONEPASS_CLIENT_SECRET};
}

export function onePassMembersUrl(env: OnePassEnv): string | null {
  try {
    const { origin } = config(env);
    const url = new URL(`/products/${encodeURIComponent(env.ONEPASS_PRODUCT_CODE!)}/environments/${env.ONEPASS_ENVIRONMENT}/members`, origin);
    url.searchParams.set('org', env.ONEPASS_ORG_ID!);
    return url.href;
  } catch {
    return null;
  }
}

function cookieName(url:URL,key:string){return (url.protocol==='https:'?'__Host-':'')+'onepass_'+key;}
function cookie(request:Request,key:string) {
  const name=cookieName(new URL(request.url),key)+'=';
  const matches=(request.headers.get('cookie')??'').split(';').map(v=>v.trim()).filter(v=>v.startsWith(name));
  return matches.length===1?(matches[0]?.slice(name.length)??null):null;
}
function setCookie(headers:Headers,url:URL,key:string,value:string,ttl:number) {
  headers.append('set-cookie',cookieName(url,key)+'='+value+'; Path=/; HttpOnly; SameSite=Lax; Max-Age='+ttl+(url.protocol==='https:'?'; Secure':''));
}
async function sessionCall(cfg:ReturnType<typeof config>,op:string,body:object) {
  const resp=await fetch(new URL('/api/integrations/v1/session/'+op,cfg.origin),{
    method:'POST',headers:{'content-type':'application/json',authorization:'Basic '+btoa(cfg.clientId+':'+cfg.clientSecret)},
    body:JSON.stringify(body),redirect:'manual',signal:AbortSignal.timeout(6000),
  });
  if(resp.status===401||resp.status===403) return null;
  if(!resp.ok) throw Error('OnePass session service unavailable');
  return resp.json();
}

function validAuthenticatedEmail(email:unknown,env:OnePassEnv):email is string {
  if(typeof email!=='string'||email.length>254||!/^[^@\s\x00-\x1f]+@[^@\s\x00-\x1f]+\.[^@\s\x00-\x1f]+$/.test(email)) return false;
  const domain=env.ONEPASS_REQUIRED_EMAIL_DOMAIN?.trim().toLowerCase()||(env.ONEPASS_ENVIRONMENT==='production'?'lancloudtech.com':'');
  return !domain||email.split('@')[1]?.toLowerCase()===domain;
}

function isIdentity(value:unknown,env:OnePassEnv):value is OnePassIdentity {
  if(!value||typeof value!=='object') return false;
  const i=value as Partial<OnePassIdentity>;
  return i.active===true&&(i.access_model===undefined||i.access_model==='subscription'||i.access_model==='unlimited')&&uuid(i.session_id)&&uuid(i.application_user_id)&&uuid(i.user?.id)&&
    typeof i.user?.name==='string'&&i.user?.email_verified===true&&validAuthenticatedEmail(i.user?.email,env)&&
    uuid(i.membership?.id)&&i.membership?.org_id===env.ONEPASS_ORG_ID&&
    ['administrator','member'].includes(i.membership?.role??'')&&
    (i.membership?.application_roles===undefined||isApplicationRoles(i.membership.application_roles))&&
    typeof i.expires_at==='string'&&Date.parse(i.expires_at)>Date.now();
}
async function locallyActive(identity:OnePassIdentity,env:OnePassEnv) {
  const roles = encodeApplicationRoles(identity.membership.application_roles);
  if (roles === null && env.ONEPASS_MANAGED_MEMBER_ROLES === '1') return false;
  // This value comes only from the authenticated OnePass session response.
  // Missing is the legacy subscription model; unknown values fail validation.
  const entitlementCheck = identity.access_model === 'unlimited' ? '' : `AND EXISTS (
    SELECT 1 FROM onepass_entitlement e WHERE e.org_id = g.org_id
      AND e.status='active' AND julianday(e.period_end)>julianday('now')
  )`;
  const grantQuery = `SELECT 1 AS active FROM onepass_grants g JOIN onepass_org o ON o.org_id=g.org_id
    WHERE g.membership_id=? AND g.org_id=? AND g.application_user_id=? AND g.role=? AND g.enabled=1
      AND g.application_roles_json IS ? ${entitlementCheck}`;
  const grant=await env.DB.prepare(grantQuery)
    .bind(identity.membership.id,identity.membership.org_id,identity.application_user_id,identity.membership.role,roles).first();
  return !!grant;
}
export async function onePassIdentity(request:Request,env:OnePassEnv):Promise<OnePassIdentity|null> {
  if(!onePassEnabled(env)) return null;
  const cfg=config(env);
  if(new URL(request.url).origin!==cfg.redirect.origin) return null;
  const sessionId=cookie(request,'session');
  if(!uuid(sessionId)) return null;
  const identity=await sessionCall(cfg,'check',{session_id:sessionId,require_email:true});
  return isIdentity(identity,env)&&identity.session_id===sessionId&&await locallyActive(identity,env)?identity:null;
}

async function eventRequest(request:Request,env:OnePassEnv,cfg:ReturnType<typeof config>):Promise<Response> {
  const raw=await request.text();
  if(encoder.encode(raw).byteLength>16384) return new Response(null,{status:413});
  const entitlement=request.headers.has('x-lh-subscription-signature');
  const prefix=entitlement?'x-lh-subscription-':'x-onepass-';
  const keyId=request.headers.get(prefix+'key-id'), ts=request.headers.get(prefix+'timestamp');
  const nonce=request.headers.get(prefix+'nonce'), signature=request.headers.get(prefix+'signature');
  if(keyId!==env.ONEPASS_DELIVERY_KEY_ID||!ts||!/^\d{10}$/.test(ts)||Math.abs(Date.now()/1000-Number(ts))>120||
    !uuid(nonce)||!signature||!/^v1=[a-f0-9]{64}$/.test(signature)) return forbidden();
  const digest=hex(await hash(raw));
  const canonical=[entitlement?'LH-SUBSCRIPTION-SYNC-V1':'ONEPASS-INTEGRATION-V1',
    keyId,ts,nonce,'POST',new URL(request.url).pathname,digest].join('\n');
  const bytes=new Uint8Array(signature.slice(3).match(/../g)!.map(c=>Number.parseInt(c,16)));
  const cryptoKey=await crypto.subtle.importKey('raw',cfg.raw,{name:'HMAC',hash:'SHA-256'},false,['verify']);
  if(!await crypto.subtle.verify('HMAC',cryptoKey,bytes,encoder.encode(canonical))) return forbidden();
  const event=JSON.parse(raw);
  if(!uuid(event?.event_id)||event.product_code!==env.ONEPASS_PRODUCT_CODE) return forbidden();
  if(entitlement){
    if(event.source?.issuer!=='onepass-subscriptions'||event.source?.environment!==env.ONEPASS_ENVIRONMENT||
      event.audience?.environment!==env.ONEPASS_ENVIRONMENT||event.audience?.instance_id!==env.ONEPASS_INSTANCE_ID||
      ![2,3].includes(event.protocol_version)) return forbidden();
  }else if(event.environment!==env.ONEPASS_ENVIRONMENT||event.instance_id!==env.ONEPASS_INSTANCE_ID||![1,2].includes(event.protocol_version)||
    (event.protocol_version===2&&event.type!=='membership.set')) return forbidden();
  if(!entitlement&&event.type==='probe') return Response.json({event_id:event.event_id,result:'applied'});
  const orgId=entitlement?event.subject?.org_id:event.org_id;
  if(orgId!==env.ONEPASS_ORG_ID) return forbidden();
  const receipt=env.DB.prepare('INSERT INTO onepass_receipts(event_id,payload_hash) VALUES(?,?) ON CONFLICT(event_id) DO NOTHING')
    .bind(event.event_id,digest);
  const match='EXISTS (SELECT 1 FROM onepass_receipts WHERE event_id=? AND payload_hash=?)';
  let action:D1PreparedStatement;
  const provisioning:D1PreparedStatement[]=[];
  let requiresLocalAccount=false;
  if(entitlement){
    if(!Number.isSafeInteger(event.entitlement_version)||event.entitlement_version<1||typeof event.status!=='string'||
      typeof event.period_end!=='string'||!Number.isFinite(Date.parse(event.period_end))) return forbidden();
    action=env.DB.prepare(`INSERT INTO onepass_entitlement(org_id,version,event_id,status,period_end,payload)
      SELECT ?,?,?,?,?,? WHERE ${match} ON CONFLICT(org_id) DO UPDATE SET
      version=excluded.version,event_id=excluded.event_id,status=excluded.status,period_end=excluded.period_end,payload=excluded.payload
      WHERE excluded.version>onepass_entitlement.version`)
      .bind(orgId,event.entitlement_version,event.event_id,event.status,event.period_end,raw,event.event_id,digest);
  }else if(event.type==='organization.provision'){
    action=env.DB.prepare(`INSERT INTO onepass_org(org_id) SELECT ? WHERE ${match} ON CONFLICT(org_id) DO NOTHING`)
      .bind(orgId,event.event_id,digest);
  }else if(event.type==='membership.set'){
    if(!uuid(event.membership_id)||!uuid(event.application_user_id)||!['administrator','member'].includes(event.role)||
      typeof event.enabled!=='boolean'||!Number.isSafeInteger(event.version)||event.version<1) return forbidden();
    if (event.application_roles !== undefined && !isApplicationRoles(event.application_roles)) return forbidden();
    const roles = encodeApplicationRoles(event.application_roles);
    if (event.enabled && roles === null && env.ONEPASS_MANAGED_MEMBER_ROLES === '1') return forbidden();
    requiresLocalAccount = event.enabled && (event.protocol_version === 2 || roles !== null);
    if(event.protocol_version===2 && event.enabled){
      const data=event.provisioning;
      const email=typeof data?.verified_email==='string'?data.verified_email.toLowerCase():'';
      if(data?.mode!=='new'||email.length>254||!/^[^@\s\x00-\x1f]+@lancloudtech\.com$/.test(email)||
        typeof data.name!=='string'||!data.name.trim()||data.name.length>80||/[\x00-\x1f\x7f]/.test(data.name)) return forbidden();
      // A stale or conflicting event must never create a local account.
      const previous=await env.DB.prepare('SELECT org_id,application_user_id,version,event_id FROM onepass_grants WHERE membership_id=?')
        .bind(event.membership_id).first<{org_id:string;application_user_id:string;version:number;event_id:string}>();
      if(previous&&(previous.org_id!==orgId||previous.application_user_id!==event.application_user_id||
        (previous.version>=event.version&&previous.event_id!==event.event_id))) return forbidden();
      const mapped=await env.DB.prepare('SELECT user_id FROM onepass_local_accounts WHERE org_id=? AND membership_id=?')
        .bind(orgId,event.membership_id).first();
      if(!mapped){
        if(await env.DB.prepare('SELECT 1 AS found FROM users WHERE lower(email)=?').bind(email).first()) return linkRequired();
        const userId=crypto.randomUUID();
        provisioning.push(env.DB.prepare(`INSERT INTO users(id,email,display_name,employment_status)
          SELECT ?,?,?,'active' WHERE ${match} AND NOT EXISTS (SELECT 1 FROM onepass_grants WHERE membership_id=? AND (org_id<>? OR application_user_id<>? OR version>=?))`).bind(userId,email,data.name,event.event_id,digest,event.membership_id,orgId,event.application_user_id,event.version));
        if (roles === null) {
          provisioning.push(env.DB.prepare(`INSERT INTO user_roles(user_id,role_id)
            SELECT ?,'role-employee' WHERE EXISTS(SELECT 1 FROM users WHERE id=?)`)
            .bind(userId,userId));
        }
        provisioning.push(env.DB.prepare(`INSERT INTO onepass_local_accounts(org_id,membership_id,user_id)
          SELECT ?,?,? WHERE EXISTS(SELECT 1 FROM users WHERE id=?)`)
          .bind(orgId,event.membership_id,userId,userId));
        provisioning.push(env.DB.prepare(`INSERT INTO audit_events(id,actor_id,action,entity_type,entity_id,detail_json)
          SELECT ?,NULL,'onepass_create_user','user',?,'{}' WHERE EXISTS(SELECT 1 FROM onepass_local_accounts WHERE org_id=? AND membership_id=? AND user_id=?)`)
          .bind(event.event_id,userId,orgId,event.membership_id,userId));
      }
    }
    const mappingGate=requiresLocalAccount?` AND EXISTS(SELECT 1 FROM onepass_local_accounts a JOIN users u ON u.id=a.user_id
      WHERE a.org_id=? AND a.membership_id=? AND a.enabled=1 AND u.employment_status='active')`:'';
    action=env.DB.prepare(`INSERT INTO onepass_grants(membership_id,org_id,application_user_id,role,enabled,version,event_id,application_roles_json)
      SELECT ?,?,?,?,?,?,?,? WHERE ${match}${mappingGate} ON CONFLICT(membership_id) DO UPDATE SET
      role=excluded.role,enabled=excluded.enabled,version=excluded.version,event_id=excluded.event_id,
      application_roles_json=COALESCE(excluded.application_roles_json,onepass_grants.application_roles_json)
      WHERE excluded.version>onepass_grants.version AND excluded.org_id=onepass_grants.org_id
        AND excluded.application_user_id=onepass_grants.application_user_id
        AND (excluded.enabled=0 OR excluded.application_roles_json IS NOT NULL OR onepass_grants.application_roles_json IS NULL)`)
      .bind(event.membership_id,orgId,event.application_user_id,event.role,event.enabled?1:0,event.version,event.event_id,roles,event.event_id,digest,...(requiresLocalAccount?[orgId,event.membership_id]:[]));
  }else return forbidden();
  await env.DB.batch([receipt,...provisioning,action]);
  const known=await env.DB.prepare('SELECT payload_hash FROM onepass_receipts WHERE event_id=?').bind(event.event_id).first<string>('payload_hash');
  if(known!==digest) return forbidden();
  if(entitlement){
    const latest=await env.DB.prepare('SELECT version,event_id FROM onepass_entitlement WHERE org_id=?').bind(orgId).first<{version:number;event_id:string}>();
    if(!latest||(latest.version===event.entitlement_version&&latest.event_id!==event.event_id)) return forbidden();
    return Response.json({event_id:event.event_id,org_id:orgId,entitlement_version:event.entitlement_version,
      latest_entitlement_version:latest.version,result:latest.event_id===event.event_id?'applied':'ignored_stale'});
  }
  if(event.type==='membership.set'){
    const applied=await env.DB.prepare('SELECT event_id, version, application_roles_json FROM onepass_grants WHERE membership_id=?')
      .bind(event.membership_id).first<{event_id:string; version:number; application_roles_json:string|null}>();
    if(!applied||applied.event_id!==event.event_id) {
      return requiresLocalAccount&&(!applied||applied.version<event.version)?linkRequired():forbidden();
    }
    return Response.json({event_id:event.event_id,org_id:orgId,application_user_id:event.application_user_id,version:event.version,result:'applied',
      ...(requiresLocalAccount?{local_account_ready:true}:{}),
      ...(event.application_roles===undefined?{}:{application_roles:JSON.parse(applied.application_roles_json!)}),
    });
  }
  return Response.json({event_id:event.event_id,org_id:orgId,result:'applied'});
}

export async function handleOnePass(request:Request,env:OnePassEnv):Promise<Response|null> {
  const url=new URL(request.url), path=url.pathname;
  if(!['/auth/onepass','/auth/onepass/callback','/auth/onepass/logout','/api/internal/onepass/events'].includes(path)) return null;
  if(!onePassEnabled(env)) return new Response(null,{status:404});
  try {
    const cfg=config(env);
    if(url.origin!==cfg.redirect.origin) return forbidden();
    if(path==='/api/internal/onepass/events') return request.method==='POST'?await eventRequest(request,env,cfg):new Response(null,{status:405});
    const headers=new Headers({'cache-control':'no-store','referrer-policy':'no-referrer'});
    if(path==='/auth/onepass/logout'){
      if(request.method!=='POST'||request.headers.get('origin')!==url.origin) return forbidden();
      const id=cookie(request,'session');
      if(uuid(id)) await sessionCall(cfg,'revoke',{session_id:id}).catch(()=>null);
      setCookie(headers,url,'session','',0);
      headers.set('location','/');return new Response(null,{status:303,headers});
    }
    if(request.method!=='GET') return new Response(null,{status:405});
    if(path==='/auth/onepass'){
      const state=random(), verifier=random();
      const authorize=new URL('/authorize',cfg.origin);
      authorize.search=new URLSearchParams({client_id:cfg.clientId,redirect_uri:cfg.redirect.href,
        state,code_challenge:base64url(new Uint8Array(await hash(verifier))),code_challenge_method:'S256'}).toString();
      setCookie(headers,url,'transaction',state+'.'+verifier,600);
      headers.set('location',authorize.href);return new Response(null,{status:303,headers});
    }
    const [state,verifier]=cookie(request,'transaction')?.split('.')??[];
    const code=url.searchParams.get('code');
    if(!token(state)||!token(verifier)||!token(code)||url.searchParams.get('state')!==state) return forbidden();
    const identity=await sessionCall(cfg,'exchange',{code,redirect_uri:cfg.redirect.href,code_verifier:verifier,require_email:true});
    if(!isIdentity(identity,env)||!await locallyActive(identity,env)) return forbidden();
    setCookie(headers,url,'transaction','',0);
    setCookie(headers,url,'session',identity.session_id,Math.min(28800,Math.max(1,Math.floor((Date.parse(identity.expires_at)-Date.now())/1000))));
    headers.set('location','/');return new Response(null,{status:303,headers});
  } catch {
    return unavailable();
  }
}
