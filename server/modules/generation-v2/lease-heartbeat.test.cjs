'use strict';
const test=require('node:test');const assert=require('node:assert/strict');
const {withLeaseHeartbeat}=require('./lease-heartbeat.cjs');

test('长任务周期续租，完成后停止timer',async()=>{let renews=0;const pg={};const result=await withLeaseHeartbeat(pg,{itemId:'i',leaseVersion:2,workerId:'w',intervalMs:5,leaseSeconds:30,states:['generating']},{renewLease:async()=>{renews++;return{item_id:'i'}}},async()=>{await new Promise(r=>setTimeout(r,22));return'ok'});assert.equal(result,'ok');assert.ok(renews>=2,`续租${renews}次`);const atEnd=renews;await new Promise(r=>setTimeout(r,15));assert.equal(renews,atEnd)});

test('首次续租失败立即中止且不执行外部操作',async()=>{let called=false;await assert.rejects(()=>withLeaseHeartbeat({}, {itemId:'i',leaseVersion:1,workerId:'w',intervalMs:5},{renewLease:async()=>null},async()=>{called=true}),/lease lost/);assert.equal(called,false)});

test('执行中续租失败通过AbortSignal通知provider操作',async()=>{let n=0,aborted=false;await assert.rejects(()=>withLeaseHeartbeat({}, {itemId:'i',leaseVersion:1,workerId:'w',intervalMs:5},{renewLease:async()=>++n===1?{item_id:'i'}:null},async signal=>{await new Promise((resolve,reject)=>{signal.addEventListener('abort',()=>{aborted=true;reject(signal.reason)},{once:true});setTimeout(resolve,50)})}),/lease lost/);assert.equal(aborted,true)});

test('参数缺失时拒绝执行',async()=>{await assert.rejects(()=>withLeaseHeartbeat({}, {itemId:'i'}, {}, async()=>{}),/workerId/)});
