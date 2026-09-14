'use strict';
const test=require('node:test');const assert=require('node:assert/strict');
const {evaluateProductionGate,buildLoadPlan}=require('./production-gate.cjs');

test('生产门槛要求真实PG、迁移、影子一致性、故障与压测证据',()=>{
 const r=evaluateProductionGate({unitPass:true,migration:true,pgIntegration:true,shadowAudit:{sampled:12,consistent:12},chaos:{workerKill:true,redisRestart:true,provider429:true},load:{p95SubmitMs:300,duplicateRate:0,ledgerMismatch:0,oldestQueueSec:600},secrets:true,dependencies:true,observability:true});
 assert.equal(r.ready,true);assert.deepEqual(r.blockers,[]);
});

test('缺任一商业生产证据则阻断真实worker',()=>{
 const r=evaluateProductionGate({unitPass:true,migration:true,pgIntegration:false,shadowAudit:{sampled:0,consistent:0},chaos:{},load:{},secrets:false,dependencies:false,observability:false});
 assert.equal(r.ready,false);assert.ok(r.blockers.length>=5);assert.ok(r.blockers.some(x=>/PostgreSQL/.test(x)));assert.ok(r.blockers.some(x=>/影子/.test(x)));
});

test('buildLoadPlan覆盖1000在线与突发图片场景',()=>{
 const p=buildLoadPlan({onlineUsers:1000,burstUsers:300,imagesPerUser:4});
 assert.equal(p.onlineUsers,1000);assert.equal(p.burstImages,1200);assert.deepEqual(p.scenarios.map(x=>x.name),['submit-burst','steady-ramp','provider-429','worker-kill','soak']);assert.ok(p.acceptance.p95SubmitMs<=300);assert.equal(p.acceptance.maxDuplicateRate,0)});
