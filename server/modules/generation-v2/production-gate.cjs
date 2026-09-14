'use strict';

function evaluateProductionGate(evidence={}){
 const blockers=[];
 if(!evidence.unitPass)blockers.push('V2单元测试未通过');
 if(!evidence.migration)blockers.push('生产迁移未执行或未验证');
 if(!evidence.pgIntegration)blockers.push('真实PostgreSQL并发集成测试未通过');
 const a=evidence.shadowAudit||{};
 if(!(a.sampled>0&&a.consistent===a.sampled))blockers.push('影子样本不足或一致性不完整');
 const c=evidence.chaos||{};
 if(!c.workerKill||!c.redisRestart||!c.provider429)blockers.push('故障注入未全部通过');
 const l=evidence.load||{};
 if(!(Number(l.p95SubmitMs)<=300&&Number(l.duplicateRate)===0&&Number(l.ledgerMismatch)===0&&Number(l.oldestQueueSec)<=1200))blockers.push('容量压测未达到SLO');
 if(!evidence.secrets)blockers.push('生产密钥管理未达标');
 if(!evidence.dependencies)blockers.push('高危依赖漏洞未清零');
 if(!evidence.observability)blockers.push('监控、告警、worker heartbeat未就绪');
 return{ready:blockers.length===0,blockers};
}
function buildLoadPlan({onlineUsers=1000,burstUsers=300,imagesPerUser=4}={}){
 return{onlineUsers,burstUsers,imagesPerUser,burstImages:burstUsers*imagesPerUser,
  scenarios:[
   {name:'submit-burst',users:burstUsers,durationSec:60},
   {name:'steady-ramp',rates:[20,40,60,80,100],minutesEach:15},
   {name:'provider-429',rates:[0.05,0.2,0.5]},
   {name:'worker-kill',points:['generating','uploading','settling']},
   {name:'soak',hours:8},
  ],acceptance:{p95SubmitMs:300,maxDuplicateRate:0,maxLedgerMismatch:0,maxQueueAgeSec:1200}};
}
module.exports={evaluateProductionGate,buildLoadPlan};
