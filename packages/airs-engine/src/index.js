export function privacyTransform(rows=[]){return rows.map(({rawFreeText,...r})=>({...r,rawFreeText:rawFreeText?"[REDACTED_PENDING_SANITISATION]":null}))}
export function reconcile(){return {status:"REVIEW_REQUIRED",relationships:[],unknowns:[],notes:["Unknown and conflicting are valid outcomes.","Team self-report is not technical proof."]}}
