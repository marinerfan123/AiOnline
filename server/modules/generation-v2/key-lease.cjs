'use strict';
const crypto=require('crypto');
const ACQUIRE_KEY_LUA=`
local leases=KEYS[1]
local cooldown=KEYS[2]
local cursor=KEYS[3]
local now=tonumber(ARGV[1])
local ttl=tonumber(ARGV[2])
local leaseToken=ARGV[3]
local candidates=cjson.decode(ARGV[4])
redis.call('ZREMRANGEBYSCORE',leases,'-inf',now)
local start=tonumber(redis.call('GET',cursor) or '0')
for step=0,#candidates-1 do
 local idx=((start+step)%#candidates)+1
 local k=candidates[idx]
 local cooldownUntil=tonumber(redis.call('HGET',cooldown,k.id) or tostring(k.cooldown or 0))
 local active=redis.call('ZCOUNT',leases,'('..now,'+inf')
 local prefix=k.id..'|'
 local members=redis.call('ZRANGEBYSCORE',leases,'('..now,'+inf')
 local keyActive=0
 for _,m in ipairs(members) do if string.sub(m,1,string.len(prefix))==prefix then keyActive=keyActive+1 end end
 local maxConcurrent=tonumber(k.maxConcurrent or 1)
 if cooldownUntil<=now and keyActive<maxConcurrent then
  local member=k.id..'|'..leaseToken
  local expires=now+ttl
  redis.call('ZADD',leases,expires,member)
  redis.call('SET',cursor,(idx%#candidates))
  return {k.id,leaseToken,tostring(expires)}
 end
end
return nil`;
const RELEASE_KEY_LUA=`local leaseToken=ARGV[2] local member=ARGV[1]..'|'..leaseToken return redis.call('ZREM',KEYS[1],member)`;
function base(providerId){return`generation-v2:keylease:${providerId}`}
async function acquireKeyLease(redis,opt={}){if(!redis||typeof redis.eval!=='function')throw new TypeError('redis.eval is required');if(!opt.providerId)throw new TypeError('providerId is required');const keys=(opt.keys||[]).filter(k=>k&&k.id).slice(0,500).map(k=>({id:String(k.id),maxConcurrent:Math.max(1,Number(k.maxConcurrent)||1),cooldown:Number(k.cooldownUntil)||0}));if(!keys.length)return null;const now=Number(opt.now)||Date.now(),ttl=Math.max(1000,Math.min(15*60*1000,Number(opt.ttlMs)||120000)),token=opt.token||crypto.randomUUID(),b=base(opt.providerId);let r;try{r=await redis.eval(ACQUIRE_KEY_LUA,3,`${b}:leases`,`${b}:cooldown`,`${b}:cursor`,now,ttl,token,JSON.stringify(keys))}catch(e){const cb=opt.onError||null;if(typeof cb==='function')cb(e);return null}if(!r)return null;return{keyId:r[0],token:r[1],expiresAt:Number(r[2])}}
async function releaseKeyLease(redis,{providerId,keyId,token}={}){if(!redis||typeof redis.eval!=='function')throw new TypeError('redis.eval is required');if(!providerId||!keyId||!token)throw new TypeError('providerId/keyId/token required');try{return Number(await redis.eval(RELEASE_KEY_LUA,1,`${base(providerId)}:leases`,keyId,token))>0}catch(e){return false}}
module.exports={ACQUIRE_KEY_LUA,RELEASE_KEY_LUA,acquireKeyLease,releaseKeyLease};
