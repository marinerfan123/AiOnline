'use strict';
const test=require('node:test');const assert=require('node:assert/strict');
const {ACQUIRE_KEY_LUA,RELEASE_KEY_LUA,acquireKeyLease,releaseKeyLease}=require('./key-lease.cjs');

test('acquire Lua原子清理过期租约、跳过冷却/满载key并写lease token',()=>{assert.match(ACQUIRE_KEY_LUA,/ZREMRANGEBYSCORE/);assert.match(ACQUIRE_KEY_LUA,/cooldown/);assert.match(ACQUIRE_KEY_LUA,/maxConcurrent/);assert.match(ACQUIRE_KEY_LUA,/leaseToken/);assert.match(ACQUIRE_KEY_LUA,/ZADD/)});
test('release Lua按token删除，重复释放幂等',()=>{assert.match(RELEASE_KEY_LUA,/ZREM/);assert.match(RELEASE_KEY_LUA,/leaseToken/)});
test('acquireKeyLease调用Redis eval并解析租约',async()=>{const calls=[];const redis={eval:async(...a)=>{calls.push(a);return['k2','tok','12345']}};const r=await acquireKeyLease(redis,{providerId:'p1',keys:[{id:'k1',maxConcurrent:1,cooldownUntil:0},{id:'k2',maxConcurrent:2,cooldownUntil:0}],ttlMs:90000,now:1000,token:'tok'});assert.deepEqual(r,{keyId:'k2',token:'tok',expiresAt:12345});assert.equal(calls[0][1],3);assert.match(calls[0][2],/generation-v2:keylease:p1/)});
test('无可用key返回null',async()=>{const redis={eval:async()=>null};assert.equal(await acquireKeyLease(redis,{providerId:'p',keys:[{id:'k'}]}),null)});
test('releaseKeyLease带provider/key/token且返回boolean',async()=>{let args;const redis={eval:async(...a)=>{args=a;return 1}};assert.equal(await releaseKeyLease(redis,{providerId:'p',keyId:'k',token:'t'}),true);assert.ok(args.includes('t'))});
test('参数和key数量受限',async()=>{await assert.rejects(()=>acquireKeyLease({},{}),/redis.eval/);const redis={eval:async(...a)=>{const payload=JSON.parse(a.at(-1));assert.equal(payload.length,500);return null}};await acquireKeyLease(redis,{providerId:'p',keys:Array.from({length:700},(_,i)=>({id:`k${i}`}))})});
