'use strict';
const test=require('node:test');const assert=require('node:assert/strict');
const {createWorkerDaemon}=require('./worker-daemon.cjs');

function makeOpts(overrides={}){return{workerId:'w1',pgPool:{},redis:{},tickIntervalMs:5,gracefulShutdownMs:50,...overrides}}

test('daemon启动后运行tick，signal停止后不再触发',async()=>{let ticks=0;const daemon=createWorkerDaemon({...makeOpts(),tick:async()=>{ticks++}});const p=daemon.start();await new Promise(r=>setTimeout(r,22));await daemon.stop();await p;assert.ok(ticks>=2,`ticks=${ticks}`);const atStop=ticks;await new Promise(r=>setTimeout(r,15));assert.equal(ticks,atStop,'stop后不再tick')});

test('tick异常不崩溃daemon，继续下一轮',async()=>{let calls=0,errs=[];const daemon=createWorkerDaemon({...makeOpts(),tick:async()=>{calls++;if(calls===1)throw new Error('boom')},onError:e=>errs.push(e.message)});const p=daemon.start();await new Promise(r=>setTimeout(r,22));await daemon.stop();await p;assert.ok(calls>=2);assert.deepEqual(errs,['boom'])});

test('stop等待当前tick完成再退出',async()=>{let inTick=false,tickDone=false;const daemon=createWorkerDaemon({...makeOpts({gracefulShutdownMs:200}),tick:async()=>{inTick=true;await new Promise(r=>setTimeout(r,30));tickDone=true;inTick=false}});const p=daemon.start();await new Promise(r=>setTimeout(r,8));const stopP=daemon.stop();assert.equal(inTick,true,'tick应正在执行');await stopP;await p;assert.equal(tickDone,true,'tick应完成')});

test('workerId缺失时拒绝启动',async()=>{const daemon=createWorkerDaemon({...makeOpts({workerId:''}),tick:async()=>{}});await assert.rejects(()=>daemon.start(),/workerId/)});
