'use strict';
const lease=require('./lease.cjs');const ledger=require('./ledger.cjs');const uploadFinalize=require('./upload-finalize.cjs');

async function claimGeneratedItems(pg,{workerId,limit=10,leaseSeconds=120}={}){
 if(!workerId)throw new TypeError('workerId is required');const l=Math.max(1,Math.min(100,Number(limit)||10)),s=Math.max(10,Math.min(900,Number(leaseSeconds)||120));
 const r=await pg.query(`WITH picked AS (SELECT item_id FROM generation_items_v2 WHERE status='generated' ORDER BY generated_at ASC FOR UPDATE SKIP LOCKED LIMIT $1) UPDATE generation_items_v2 i SET status='uploading',lease_owner=$2,lease_expires_at=NOW()+($3*INTERVAL '1 second'),lease_version=i.lease_version+1 FROM picked WHERE i.item_id=picked.item_id RETURNING i.*`,[l,workerId,s]);return r.rows||[];
}
function objectKeyFor(item){return `generation-v2/${item.batch_id}/${item.item_index}.png`}
async function processUploadItem(pg,item,injected={}){
 const d={transitionItem:lease.transitionItem,settleHold:ledger.settleHold,reconcileBatch:ledger.reconcileBatch,finalizeUploadedItem:uploadFinalize.finalizeUploadedItem,uploadToOss:null,...injected};
 const base={itemId:item.item_id,leaseVersion:Number(item.lease_version)};
 if(!item.provider_url){const row=await d.transitionItem(pg,{...base,from:'uploading',to:'review_required',patch:{last_error_code:'PROVIDER_URL_MISSING',last_error:'providerUrl missing before upload',lease_expires_at:null}});return{status:row?'review_required':'stale_lease'}}
 const gate=await d.transitionItem(pg,{...base,from:'uploading',to:'uploading',patch:{lease_expires_at:new Date(Date.now()+120000)}});if(!gate)return{status:'stale_lease'};
 if(typeof d.uploadToOss!=='function')throw new TypeError('uploadToOss is required');
 try{const up=await d.uploadToOss({providerUrl:item.provider_url,objectKey:objectKeyFor(item),item});let finalized;if(injected.finalizeUploadedItem){finalized=await d.finalizeUploadedItem(pg,{itemId:item.item_id,leaseVersion:Number(item.lease_version),ossUrl:up.ossUrl});}else if(typeof pg.connect==='function'){finalized=await d.finalizeUploadedItem(pg,{itemId:item.item_id,leaseVersion:Number(item.lease_version),ossUrl:up.ossUrl});}else{const row=await d.transitionItem(pg,{...base,from:'uploading',to:'done',patch:{oss_url:up.ossUrl,uploaded_at:new Date(),completed_at:new Date(),lease_expires_at:null}});if(!row)return{status:'stale_lease'};await d.settleHold(pg,{itemId:item.item_id,action:'commit'});finalized={changed:true};}if(!finalized.changed)return{status:'stale_lease'};if(item.batch_id)await d.reconcileBatch(pg,item.batch_id);return{status:'done',ossUrl:up.ossUrl};}
 catch(e){const row=await d.transitionItem(pg,{...base,from:'uploading',to:'generated',patch:{last_error_code:'UPLOAD_FAILED',last_error:e.message,lease_expires_at:null}});return{status:row?'generated':'stale_lease',error:e.message}}
}
async function runUploadTick(pg,opt={},injected={}){const d={claimGeneratedItems,...injected},workerId=opt.workerId;if(!workerId)throw new TypeError('workerId is required');const concurrency=Math.max(1,Math.min(20,Number(opt.concurrency)||4));const items=await d.claimGeneratedItems(pg,{workerId,limit:opt.limit||concurrency*2,leaseSeconds:opt.leaseSeconds||120});for(let x=0;x<items.length;x+=concurrency)await Promise.all(items.slice(x,x+concurrency).map(async i=>{const full=d.loadItemContext?await d.loadItemContext(pg,i.item_id):i;return processUploadItem(pg,{...full,lease_version:i.lease_version,provider_url:i.provider_url},d)}));return{claimed:items.length}}
module.exports={claimGeneratedItems,objectKeyFor,processUploadItem,runUploadTick};
