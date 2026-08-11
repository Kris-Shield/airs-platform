import express from "express";
import helmet from "helmet";
import cors from "cors";
import crypto from "node:crypto";
import {PrismaClient} from "@prisma/client";
import {privacyTransform,reconcile} from "@airs/airs-engine";
import {buildReportDraft} from "@airs/report-generator";

// Railway rebuild marker: deploy current main including DB push script.
const db=new PrismaClient(), app=express(), port=Number(process.env.PORT||4000);
app.use(helmet()); app.use(cors()); app.use(express.json({limit:"512kb"}));
app.get("/health",(_q,r)=>r.json({ok:true,service:"airs-api"}));
const hash=t=>crypto.createHash("sha256").update(t).digest("hex");
app.get("/api/respond/:token",async(req,res)=>{const t=await db.respondentToken.findUnique({where:{tokenHash:hash(req.params.token)}});if(!t||t.revokedAt||t.expiresAt<new Date())return res.sendStatus(403);res.json({canSubmit:!t.usedAt})});
app.post("/api/respond/:token/submit",async(req,res)=>{const t=await db.respondentToken.findUnique({where:{tokenHash:hash(req.params.token)}});if(!t||t.revokedAt||t.expiresAt<new Date()||t.usedAt)return res.sendStatus(403);const a=Array.isArray(req.body?.answers)?req.body.answers:[];await db.$transaction(async tx=>{for(const x of a)await tx.response.create({data:{engagementId:t.engagementId,source:"TEAM_SELF_REPORTED",questionId:String(x.questionId),answerJson:x.answer??null,rawFreeText:x.rawFreeText??null}});await tx.respondentToken.update({where:{id:t.id},data:{usedAt:new Date()}})});res.json({submitted:true})});
app.post("/api/engagements/:id/process",async(req,res)=>{const e=await db.engagement.findUnique({where:{id:req.params.id},include:{responses:true}});if(!e)return res.sendStatus(404);const mg=e.responses.filter(x=>x.source==="MANAGEMENT_DECLARED"), team=e.responses.filter(x=>x.source==="TEAM_SELF_REPORTED");const rec=reconcile({managementSignals:mg,teamSignals:privacyTransform(team)});const draft=buildReportDraft({engagement:e,reconciliation:rec});const report=await db.report.create({data:{engagementId:e.id,status:"READY_FOR_REVIEW",structuredJson:draft}});await db.engagement.update({where:{id:e.id},data:{state:"REVIEW_REQUIRED"}});res.json({reportId:report.id,status:report.status})});
app.post("/api/admin/reports/:id/approve",async(req,res)=>{const r=await db.report.update({where:{id:req.params.id},data:{status:"APPROVED",approvedBy:req.body?.approvedBy||"AIRS_OPERATOR",approvedAt:new Date()}});await db.engagement.update({where:{id:r.engagementId},data:{state:"AIRS_APPROVED"}});res.json({approved:true})});
app.listen(port,"0.0.0.0",()=>console.log(`AIRS API ${port}`));
