'use strict';
const test=require('node:test');const assert=require('node:assert/strict');
const {reserveUserBalance,commitUserBalance,releaseUserBalance}=require('./real-ledger.cjs');

function fakePool(balance=100,hasBalance=true){const calls=[];const q={calls,async query(sql,params=[]){calls.push({sql,params});if(/BEGIN/.test(sql))return{};if(/COMMIT|ROLLBACK/.test(sql))return{};if(/SELECT.*FOR UPDATE/.test(sql)&&/users/.test(sql)){const row={id:'u1',reward_credits:hasBalance?balance:0,recharge_credits:hasBalance?balance:0};return{rows:[row],rowCount:1}}if(/SELECT.*credit_holds/.test(sql))return{rows:[],rowCount:0};if(/INSERT INTO credit_holds/.test(sql))return{rows:[{hold_id:1}],rowCount:1};if(/UPDATE credit_holds.*SET status='committed'/.test(sql))return{rows:[{hold_id:1,amount:'50.0000',pool:'reward',user_id:'u1'}],rowCount:1};if(/UPDATE credit_holds.*SET status='released'/.test(sql))return{rows:[{hold_id:1,amount:'50.0000',pool:'reward',user_id:'u1'}],rowCount:1};if(/UPDATE users/.test(sql))return{rows:[],rowCount:1};return{rows:[],rowCount:1}}};return q}

test('reserveUserBalance在事务中锁用户行、校验余额、写hold',async()=>{const pg=fakePool();const r=await reserveUserBalance(pg,{userId:'u1',amount:'50.0000',pool:'reward',ref:'idem-1'});assert.ok(r.holdId);assert.match(pg.calls[0].sql,/BEGIN/);assert.ok(pg.calls.some(c=>/SELECT.*FOR UPDATE/i.test(c.sql)&&/users/.test(c.sql)));assert.ok(pg.calls.some(c=>/INSERT INTO credit_holds/.test(c.sql)));assert.match(pg.calls.at(-1).sql,/COMMIT/)});

test('余额不足时rollback并抛出INSUFFICIENT',async()=>{const pg=fakePool(0,true);await assert.rejects(()=>reserveUserBalance(pg,{userId:'u1',amount:'50.0000',pool:'recharge',ref:'idem-2'}),/INSUFFICIENT/);assert.ok(pg.calls.some(c=>/ROLLBACK/.test(c.sql)))});

test('commitUserBalance将hold转committed并原子回写余额',async()=>{const pg=fakePool();const r=await commitUserBalance(pg,{userId:'u1',holdId:1});assert.equal(r.committed,true);assert.ok(pg.calls.some(c=>/UPDATE credit_holds.*committed/i.test(c.sql)));assert.ok(pg.calls.some(c=>/UPDATE users/.test(c.sql)))});

test('commitUserBalance幂等：hold已committed不重复扣',async()=>{const pg=fakePool();pg.query=async(sql,params=[])=>{pg.calls.push({sql,params});if(/BEGIN|COMMIT/.test(sql))return{};if(/UPDATE credit_holds/.test(sql))return{rows:[],rowCount:0};return{rows:[],rowCount:0}};const r=await commitUserBalance(pg,{userId:'u1',holdId:1});assert.equal(r.committed,false)});

test('releaseUserBalance将hold转released并还原余额',async()=>{const pg=fakePool();const r=await releaseUserBalance(pg,{userId:'u1',holdId:1});assert.equal(r.released,true);assert.ok(pg.calls.some(c=>/UPDATE credit_holds.*released/i.test(c.sql)));assert.ok(pg.calls.some(c=>/UPDATE users/.test(c.sql)))});
