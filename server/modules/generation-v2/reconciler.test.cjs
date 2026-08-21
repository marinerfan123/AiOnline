'use strict';
const test=require('node:test');const assert=require('node:assert/strict');
const {claimReconciling,resolveReconcilingItem,publishOutbox,markOutboxDelivered}=require('./reconciler.cjs');

function fakePg(rows=[]){const calls=[];return{calls,async query(sql,params=[]){calls.push({sql,params});return{rows,rowCount:rows.length}}}}

test('claimReconciling使用SKIP LOCKED领取reconciling状态子任务',async()=>{const pg=fakePg([{item_id:'i1',provider_request_id:'req1',lease_version:1}]);const r=await claimReconciling(pg,{workerId:'w1',limit:5});assert.equal(r.length,1);assert.match(pg.calls[0].sql,/status='reconciling'/);assert.match(pg.calls[0].sql,/FOR UPDATE SKIP LOCKED/);assert.match(pg.calls[0].sql,/lease_owner/);});

test('resolveReconcilingItem成功结果转generated，失败转retry_wait',async()=>{const transitions=[];const pg=fakePg();const d={transitionItem:async(_,a)=>{transitions.push(a);return{status:a.to}},queryProviderStatus:async()=>({status:'success',providerUrl:'u'})};let r=await resolveReconcilingItem(pg,{item_id:'i1',lease_version:2,provider_request_id:'r1'},d);assert.equal(r.status,'generated');assert.equal(transitions.at(-1).patch.provider_url,'u');const d2={transitionItem:async(_,a)=>{transitions.push(a);return{status:a.to}},queryProviderStatus:async()=>({status:'pending'})};r=await resolveReconcilingItem(pg,{item_id:'i2',lease_version:1,provider_request_id:'r2'},d2);assert.equal(r.status,'retry_wait')});

test('resolveReconcilingItem上游不确定时进入review_required，不释放资金',async()=>{const transitions=[];const pg=fakePg();const d={transitionItem:async(_,a)=>{transitions.push(a);return{status:a.to}},queryProviderStatus:async()=>({status:'unknown'})};const r=await resolveReconcilingItem(pg,{item_id:'i3',lease_version:1,provider_request_id:'r3'},d);assert.equal(r.status,'review_required');assert.equal(transitions.at(-1).to,'review_required')});

test('publishOutbox批量发布generation_outbox_v2未投递事件',async()=>{const pg=fakePg([{outbox_id:1,item_id:'i1',event_type:'item_done',payload:'{}'}]);const published=[];const d={publish:async(e)=>published.push(e)};const r=await publishOutbox(pg,{limit:50},d);assert.equal(r.published,1);assert.equal(published[0].item_id,'i1');assert.match(pg.calls.at(-1).sql,/UPDATE generation_outbox_v2/)});

test('markOutboxDelivered按outboxId幂等标记',async()=>{const pg=fakePg([{outbox_id:1}]);const r=await markOutboxDelivered(pg,[1,2,3]);assert.ok(r.count>=0);assert.match(pg.calls[0].sql,/UPDATE generation_outbox_v2.*delivered_at/)});
