'use strict';
const test=require('node:test');const assert=require('node:assert/strict');
const {renewLease,isAllowedTransition}=require('./lease-guard.cjs');

test('合法状态边白名单允许主链路和重试，不允许终态回退',()=>{
 for(const [a,b] of [['queued','leased'],['retry_wait','leased'],['leased','generating'],['generating','generated'],['generating','retry_wait'],['generating','reconciling'],['generated','uploading'],['uploading','done'],['uploading','generated']])assert.equal(isAllowedTransition(a,b),true,`${a}->${b}`);
 for(const [a,b] of [['done','queued'],['failed','generating'],['leased','done'],['generated','generating']])assert.equal(isAllowedTransition(a,b),false,`${a}->${b}`);
});

test('renewLease使用item+version+owner+状态+未过期CAS',async()=>{const calls=[];const pg={async query(sql,p){calls.push({sql,p});return{rows:[{item_id:'i1',lease_version:2}],rowCount:1}}};const r=await renewLease(pg,{itemId:'i1',leaseVersion:2,workerId:'w1',leaseSeconds:90,states:['generating']});assert.equal(r.item_id,'i1');const q=calls[0];assert.match(q.sql,/lease_owner=\$3/);assert.match(q.sql,/lease_expires_at>NOW\(\)/);assert.match(q.sql,/status=ANY\(\$4::text\[\]\)/);assert.deepEqual(q.p,['i1',2,'w1',['generating'],90])});

test('renewLease过期或owner不匹配返回null',async()=>{const pg={async query(){return{rows:[],rowCount:0}}};assert.equal(await renewLease(pg,{itemId:'i',leaseVersion:1,workerId:'wrong'}),null)});

test('renewLease校验参数和续期范围',async()=>{const pg={async query(sql,p){assert.equal(p[4],900);return{rows:[]}}};await renewLease(pg,{itemId:'i',leaseVersion:1,workerId:'w',leaseSeconds:9999});await assert.rejects(()=>renewLease(pg,{itemId:'i',leaseVersion:1}),/workerId/)});
