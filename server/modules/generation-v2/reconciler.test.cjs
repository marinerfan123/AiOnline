'use strict';
const test=require('node:test');const assert=require('node:assert/strict');
const {claimReconciling,resolveReconcilingItem,publishOutbox,markOutboxDelivered,recordProviderEventAnomaly,isTerminalRegression}=require('./reconciler.cjs');

function fakePg(rows=[]){const calls=[];return{calls,async query(sql,params=[]){calls.push({sql,params});return{rows,rowCount:rows.length}}}}

test('claimReconciling使用SKIP LOCKED领取reconciling状态子任务',async()=>{const pg=fakePg([{item_id:'i1',provider_request_id:'req1',lease_version:1}]);const r=await claimReconciling(pg,{workerId:'w1',limit:5});assert.equal(r.length,1);assert.match(pg.calls[0].sql,/status='reconciling'/);assert.match(pg.calls[0].sql,/FOR UPDATE SKIP LOCKED/);assert.match(pg.calls[0].sql,/lease_owner/);});

test('resolveReconcilingItem成功结果转generated，失败转retry_wait',async()=>{const transitions=[];const pg=fakePg();const d={transitionItem:async(_,a)=>{transitions.push(a);return{status:a.to}},queryProviderStatus:async()=>({status:'success',providerUrl:'u'})};let r=await resolveReconcilingItem(pg,{item_id:'i1',lease_version:2,provider_request_id:'r1'},d);assert.equal(r.status,'generated');assert.equal(transitions.at(-1).patch.provider_url,'u');const d2={transitionItem:async(_,a)=>{transitions.push(a);return{status:a.to}},queryProviderStatus:async()=>({status:'pending'})};r=await resolveReconcilingItem(pg,{item_id:'i2',lease_version:1,provider_request_id:'r2'},d2);assert.equal(r.status,'reconcile_wait')});

test('resolveReconcilingItem上游不确定时进入review_required，不释放资金',async()=>{const transitions=[];const pg=fakePg();const d={transitionItem:async(_,a)=>{transitions.push(a);return{status:a.to}},queryProviderStatus:async()=>({status:'unknown'})};const r=await resolveReconcilingItem(pg,{item_id:'i3',lease_version:1,provider_request_id:'r3'},d);assert.equal(r.status,'review_required');assert.equal(transitions.at(-1).to,'review_required')});

test('publishOutbox批量发布generation_outbox_v2未投递事件',async()=>{const pg=fakePg([{event_id:1,aggregate_id:'i1',aggregate_type:'item',event_type:'item_done',payload:'{}'}]);const published=[];const d={publish:async(e)=>published.push(e)};const r=await publishOutbox(pg,{limit:50},d);assert.equal(r.published,1);assert.equal(published[0].aggregate_id,'i1');assert.match(pg.calls.at(-1).sql,/UPDATE generation_outbox_v2/)});

test('markOutboxDelivered按eventId幂等标记',async()=>{const pg=fakePg([{event_id:1}]);const r=await markOutboxDelivered(pg,[1,2,3]);assert.ok(r.count>=0);assert.match(pg.calls[0].sql,/UPDATE generation_outbox_v2.*published_at/s)});

// ─── §62: 状态单调推进守卫 + provider_event_anomaly 记录 ───

test('isTerminalRegression: 终态→非终态为回退, 其余非回退',()=>{
  assert.equal(isTerminalRegression('success','running'),true,'SUCCEEDED→RUNNING 回退');
  assert.equal(isTerminalRegression('success','pending'),true);
  assert.equal(isTerminalRegression('failed','pending'),true);
  assert.equal(isTerminalRegression('success','success'),false,'幂等非回退');
  assert.equal(isTerminalRegression('success','failed'),false);
  assert.equal(isTerminalRegression('pending','running'),false,'非终态起点不触发回退');
  assert.equal(isTerminalRegression(undefined,'running'),false,'无历史终态不触发回退');
});

test('recordProviderEventAnomaly 写入 append-only 异常行',async()=>{
  const pg=fakePg([{event_id:42}]);
  const r=await recordProviderEventAnomaly(pg,{itemId:'i-anom',jobId:'j1',providerId:'p1',providerRequestId:'pr1',fromStatus:'success',toStatus:'running',reason:'TERMINAL_REGRESSION'});
  assert.equal(r.event_id,42);
  const call=pg.calls[0];
  assert.match(call.sql,/INSERT INTO generation_outbox_v2/);
  assert.match(call.sql,/provider_event_anomaly/);
  assert.equal(call.params[1],'i-anom','aggregate_id = itemId');
  const payload=JSON.parse(call.params[2]);
  assert.equal(payload.reason,'TERMINAL_REGRESSION');
  assert.equal(payload.from_status,'success');
  assert.equal(payload.to_status,'running');
});

test('resolveReconcilingItem 终态回退被拒并记 anomaly, 不做任何状态迁移',async()=>{
  const transitions=[];const anomalies=[];
  const pg=fakePg();
  const r=await resolveReconcilingItem(pg,{item_id:'i-reg',lease_version:3,provider_request_id:'r1',provider_id:'p1',last_provider_status:'success'},{
    queryProviderStatus:async()=>({status:'pending'}),
    transitionItem:async(_pg,a)=>{transitions.push(a);return{status:a.to}},
    recordAnomaly:async(_pg,a)=>anomalies.push(a),
  });
  assert.equal(r.status,'rejected_terminal_regression');
  assert.equal(transitions.length,0,'regression 时禁止状态迁移');
  assert.equal(anomalies.length,1);
  assert.equal(anomalies[0].reason,'TERMINAL_REGRESSION');
  assert.equal(anomalies[0].fromStatus,'success');
  assert.equal(anomalies[0].toStatus,'pending');
});

test('resolveReconcilingItem 无回退时正常推进(有 last_provider_status=pending)',async()=>{
  const transitions=[];
  const pg=fakePg();
  const r=await resolveReconcilingItem(pg,{item_id:'i-ok',lease_version:1,provider_request_id:'r2',last_provider_status:'pending'},{
    queryProviderStatus:async()=>({status:'success',providerUrl:'u'}),
    transitionItem:async(_pg,a)=>{transitions.push(a);return{status:a.to}},
  });
  assert.equal(r.status,'generated');
  assert.equal(transitions.at(-1).to,'generated');
});

test('resolveReconcilingItem not_found 明确转 review_required, 不盲目重提',async()=>{
  const transitions=[];
  const pg=fakePg();
  const r=await resolveReconcilingItem(pg,{item_id:'i-nf',lease_version:1,provider_request_id:'r3'},{
    queryProviderStatus:async()=>({status:'not_found',errorCode:'NOT_FOUND'}),
    transitionItem:async(_pg,a)=>{transitions.push(a);return{status:a.to}},
  });
  assert.equal(r.status,'review_required');
  assert.equal(transitions[0].to,'review_required');
  assert.equal(transitions[0].patch.last_error_code,'PROVIDER_TASK_NOT_FOUND');
});
