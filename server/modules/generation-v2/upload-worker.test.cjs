'use strict';
const test=require('node:test');const assert=require('node:assert/strict');
const {claimGeneratedItems,processUploadItem,runUploadTick}=require('./upload-worker.cjs');

function fakePg(rows=[]){const calls=[];return{calls,async query(sql,params=[]){calls.push({sql,params});return{rows,rowCount:rows.length}}}}

test('claimGeneratedItems使用SKIP LOCKED把generated原子推进uploading并递增fencing',async()=>{
 const pg=fakePg([{item_id:'i1',status:'uploading',lease_version:3}]);const r=await claimGeneratedItems(pg,{workerId:'u1',limit:8,leaseSeconds:120});
 assert.equal(r.length,1);const q=pg.calls[0];assert.match(q.sql,/status='generated'/);assert.match(q.sql,/FOR UPDATE SKIP LOCKED/);assert.match(q.sql,/status='uploading'/);assert.match(q.sql,/lease_version=i\.lease_version\+1/);
});

test('processUploadItem成功时确定性objectKey且uploading→done',async()=>{
 const transitions=[];let key;
 const deps={uploadToOss:async({objectKey})=>{key=objectKey;return{ossUrl:'https://oss/x'}},transitionItem:async(_pg,a)=>{transitions.push(a);return{status:a.to}},settleHold:async()=>({changed:true}),reconcileBatch:async()=>({status:'done'})};
 const item={item_id:'i1',batch_id:'b1',item_index:2,lease_version:4,provider_url:'https://p/x.png'};
 const r=await processUploadItem({},item,deps);assert.equal(r.status,'done');assert.equal(key,'generation-v2/b1/2.png');assert.equal(transitions.at(-1).to,'done');assert.equal(transitions.at(-1).patch.oss_url,'https://oss/x');
});

test('旧upload worker CAS失败时不上传',async()=>{let called=false;const r=await processUploadItem({}, {item_id:'i',lease_version:1,provider_url:'x'}, {transitionItem:async()=>null,uploadToOss:async()=>{called=true}});assert.equal(r.status,'stale_lease');assert.equal(called,false)});

test('providerUrl缺失进入review_required，不重新生成也不commit',async()=>{const ts=[];let settle=false;const r=await processUploadItem({}, {item_id:'i',lease_version:1,provider_url:null}, {transitionItem:async(_p,a)=>{ts.push(a);return{status:a.to}},settleHold:async()=>{settle=true}});assert.equal(r.status,'review_required');assert.equal(ts.at(-1).to,'review_required');assert.equal(settle,false)});

test('上传异常回generated供上传重试，不回queued/generating',async()=>{const ts=[];const r=await processUploadItem({}, {item_id:'i',lease_version:1,provider_url:'x'}, {transitionItem:async(_p,a)=>{ts.push(a);return{status:a.to}},uploadToOss:async()=>{throw new Error('oss down')}});assert.equal(r.status,'generated');assert.equal(ts.at(-1).to,'generated')});

test('runUploadTick按concurrency限制并发',async()=>{let a=0,max=0;const items=Array.from({length:6},(_,i)=>({item_id:`i${i}`,batch_id:'b',item_index:i,lease_version:1,provider_url:'x'}));const deps={claimGeneratedItems:async()=>items,transitionItem:async(_p,x)=>({status:x.to}),uploadToOss:async()=>{a++;max=Math.max(max,a);await new Promise(r=>setTimeout(r,5));a--;return{ossUrl:'u'}},settleHold:async()=>({}),reconcileBatch:async()=>({})};const r=await runUploadTick({}, {workerId:'u',concurrency:2},deps);assert.equal(r.claimed,6);assert.ok(max<=2)});
