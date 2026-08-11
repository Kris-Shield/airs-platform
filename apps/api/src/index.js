import express from "express";
import helmet from "helmet";
import cors from "cors";
import crypto from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { privacyTransform, reconcile } from "@airs/airs-engine";
import { buildReportDraft } from "@airs/report-generator";

const db = new PrismaClient();
const app = express();
const port = Number(process.env.PORT || 4000);

app.use(helmet());
app.use(cors());
app.use(express.json({ limit: "512kb" }));

const hash = (value) => crypto.createHash("sha256").update(value).digest("hex");
const asyncRoute = (handler) => (req, res, next) =>
  Promise.resolve(handler(req, res, next)).catch(next);

function secureEqual(left, right) {
  const a = Buffer.from(left || "");
  const b = Buffer.from(right || "");
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function requireOperator(req, res, next) {
  const key = process.env.ADMIN_API_KEY;
  if (!key) return res.status(503).json({ error: "operator_auth_not_configured" });
  const header = req.get("authorization") || "";
  const supplied = header.startsWith("Bearer ") ? header.slice(7) : "";
  if (!secureEqual(supplied, key)) return res.status(401).json({ error: "unauthorized" });
  next();
}

app.get("/health", (_req, res) => res.json({ ok: true, service: "airs-api" }));

app.get(
  "/api/respond/:token",
  asyncRoute(async (req, res) => {
    const token = await db.respondentToken.findUnique({
      where: { tokenHash: hash(req.params.token) },
    });
    if (!token || token.revokedAt || token.expiresAt < new Date()) {
      return res.sendStatus(403);
    }
    res.json({ canSubmit: !token.usedAt });
  }),
);

app.post(
  "/api/respond/:token/submit",
  asyncRoute(async (req, res) => {
    const token = await db.respondentToken.findUnique({
      where: { tokenHash: hash(req.params.token) },
    });
    if (!token || token.revokedAt || token.expiresAt < new Date() || token.usedAt) {
      return res.sendStatus(403);
    }

    const answers = Array.isArray(req.body?.answers) ? req.body.answers : [];
    if (!answers.length) return res.status(400).json({ error: "answers_required" });

    await db.$transaction(async (tx) => {
      for (const answer of answers) {
        await tx.response.create({
          data: {
            engagementId: token.engagementId,
            source: "TEAM_SELF_REPORTED",
            questionId: String(answer.questionId),
            answerJson: answer.answer ?? null,
            rawFreeText: answer.rawFreeText ?? null,
          },
        });
      }
      await tx.respondentToken.update({
        where: { id: token.id },
        data: { usedAt: new Date() },
      });
    });

    res.json({ submitted: true });
  }),
);

app.post(
  "/api/engagements/:id/process",
  requireOperator,
  asyncRoute(async (req, res) => {
    const engagement = await db.engagement.findUnique({
      where: { id: req.params.id },
      include: { responses: true, reports: true },
    });
    if (!engagement) return res.sendStatus(404);
    if (engagement.reports.some((report) => report.status === "READY_FOR_REVIEW")) {
      return res.status(409).json({ error: "review_already_pending" });
    }

    const management = engagement.responses.filter(
      (response) => response.source === "MANAGEMENT_DECLARED",
    );
    const team = engagement.responses.filter(
      (response) => response.source === "TEAM_SELF_REPORTED",
    );
    const reconciliation = reconcile({
      managementSignals: management,
      teamSignals: privacyTransform(team),
    });
    const draft = buildReportDraft({ engagement, reconciliation });

    const report = await db.$transaction(async (tx) => {
      await tx.evidenceSignal.createMany({
        data: engagement.responses.map((response) => ({
          engagementId: engagement.id,
          source: response.source,
          signalType: "DISCOVERY_RESPONSE",
          payload: response.answerJson,
          provenance: {
            responseId: response.id,
            questionId: response.questionId,
            evidenceClass:
              response.source === "TEAM_SELF_REPORTED" ? "self_report" : "declared",
          },
        })),
      });
      const created = await tx.report.create({
        data: {
          engagementId: engagement.id,
          status: "READY_FOR_REVIEW",
          structuredJson: draft,
        },
      });
      await tx.engagement.update({
        where: { id: engagement.id },
        data: { state: "REVIEW_REQUIRED" },
      });
      return created;
    });

    res.json({ reportId: report.id, status: report.status });
  }),
);

app.post(
  "/api/admin/e2e/bootstrap",
  requireOperator,
  asyncRoute(async (_req, res) => {
    const runId = crypto.randomUUID();
    const respondentToken = crypto.randomBytes(32).toString("base64url");
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000);

    const created = await db.$transaction(async (tx) => {
      const organisation = await tx.organisation.create({
        data: { name: `AIRS E2E ${runId}` },
      });
      const operator = await tx.user.create({
        data: {
          email: `e2e+${runId}@airs.invalid`,
          role: "AIRS_OPERATOR",
          organisationId: organisation.id,
        },
      });
      const engagement = await tx.engagement.create({
        data: {
          organisationId: organisation.id,
          responses: {
            create: {
              source: "MANAGEMENT_DECLARED",
              questionId: "E2E-MGMT-001",
              answerJson: { declared: "controlled_e2e_signal" },
            },
          },
          respondentTokens: {
            create: {
              tokenHash: hash(respondentToken),
              expiresAt,
            },
          },
        },
      });
      return { organisation, operator, engagement };
    });

    res.status(201).json({
      runId,
      organisationId: created.organisation.id,
      operatorId: created.operator.id,
      engagementId: created.engagement.id,
      respondentToken,
      expiresAt: expiresAt.toISOString(),
    });
  }),
);

app.get(
  "/api/admin/reports/:id",
  requireOperator,
  asyncRoute(async (req, res) => {
    const report = await db.report.findUnique({
      where: { id: req.params.id },
      include: { engagement: { select: { state: true } } },
    });
    if (!report) return res.sendStatus(404);
    res.json({
      id: report.id,
      status: report.status,
      engagementState: report.engagement.state,
      approvedBy: report.approvedBy,
      approvedAt: report.approvedAt,
      deliveredAt: report.deliveredAt,
    });
  }),
);

app.post(
  "/api/admin/reports/:id/approve",
  requireOperator,
  asyncRoute(async (req, res) => {
    const report = await db.report.findUnique({ where: { id: req.params.id } });
    if (!report) return res.sendStatus(404);
    if (report.status !== "READY_FOR_REVIEW") {
      return res.status(409).json({ error: "report_not_ready_for_review" });
    }

    await db.$transaction([
      db.report.update({
        where: { id: report.id },
        data: {
          status: "APPROVED",
          approvedBy: req.body?.approvedBy || "AIRS_OPERATOR",
          approvedAt: new Date(),
        },
      }),
      db.engagement.update({
        where: { id: report.engagementId },
        data: { state: "AIRS_APPROVED" },
      }),
    ]);

    res.json({ approved: true });
  }),
);

app.use((error, _req, res, _next) => {
  console.error(error);
  res.status(500).json({ error: "internal_error" });
});

app.listen(port, "0.0.0.0", () => console.log(`AIRS API ${port}`));
