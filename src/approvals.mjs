// Single-use, in-memory approvals prevent replay or accidental side effects.
import {randomBytes} from 'node:crypto';
const pending=new Map();
export function stageApproval(tool,args,summary){
 for(const [k,p] of pending)if(p.expires<=Date.now())pending.delete(k);
 if(pending.size>=20)throw new Error('Too many pending confirmations.');
 const token=randomBytes(6).toString('hex');
 pending.set(token,{tool,args,summary,expires:Date.now()+5*60*1000});
 return token;
}
export function takeApproval(token){
 const key=String(token||'').toLowerCase(),job=pending.get(key);
 pending.delete(key);
 return job&&job.expires>Date.now()?job:null;
}
export function cancelApproval(token){return pending.delete(String(token||'').toLowerCase());}
