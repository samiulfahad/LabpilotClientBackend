/**
 * indoorReportRoutes.js
 *
 * Structure mirrors invoiceRoutes.js: Constants → Helpers → Route Schemas → Routes.
 * All routes here are permission-gated (testReportDownload / testReportUpload) —
 * no "intentionally unguarded" routes in this file.
 *
 * IPD is a hospital-only module — the onRequest hook below blocks diagnosticCenter
 * labs from reaching any route here, mirroring the isHospital guard pattern used
 * in cashmemo/commissionReport/salesReport routes.
 *
 * GET /indoorReport/:patientId/:testId also returns `overrides`: the lab's
 * custom reference ranges / values / units for the test (tests.schema.overrides),
 * filtered to the entry's schemaId. The upload screen merges them into the
 * admin schema so new reports are baked with the lab's values.
 */

import toObjectId from "../../utils/db.js";
const notDeletedFilter = (req) => ({ labId: toObjectId(req.user.labId), "deletion.at": null });

// ─── Constants ────────────────────────────────────────────────────────────────

const COLLECTION = "indoorPatients";

// ─── Helpers ──────────────────────────────────────────────────────────────────

// A test can appear multiple times on the same admission (e.g. repeat labs),
// so a bare testId isn't always unique — addedAt disambiguates which entry
// a request means. add/GET-without-addedAt fall back to "first incomplete"
// / "first completed, else first" respectively; update/dates/GET-with-addedAt
// require an exact addedAt match.
const findReportIndex = (reports, testId, addedAt) =>
  (reports ?? []).findIndex((r) => r.testId?.toString() === testId.toString() && r.addedAt === Number(addedAt));

// sampleCollectionDate/reportDate are set independently of the report body
// (via PUT /indoorReport/dates) and must survive being overwritten whenever
// the report content itself is added or updated.
const mergeReportDates = (existingReport, incomingReport) => ({
  ...incomingReport,
  ...(existingReport?.sampleCollectionDate !== undefined && {
    sampleCollectionDate: existingReport.sampleCollectionDate,
  }),
  ...(existingReport?.reportDate !== undefined && {
    reportDate: existingReport.reportDate,
  }),
});

// ─── Route Schemas ────────────────────────────────────────────────────────────

const addReportSchema = {
  schema: {
    tags: ["Indoor Reports"],
    summary: "Add a report to the first pending (incomplete) entry for a test on an admission",
    body: {
      type: "object",
      required: ["report", "patientId", "testId"],
      properties: {
        report: { type: "object", description: "Report data keyed by schema field name" },
        patientId: { type: "string", minLength: 24, maxLength: 24, description: "ObjectId of the admission" },
        testId: { type: "string", minLength: 24, maxLength: 24, description: "ObjectId of the test" },
      },
    },
  },
};

const updateReportSchema = {
  schema: {
    tags: ["Indoor Reports"],
    summary: "Update the report for a specific entry, disambiguated by addedAt",
    body: {
      type: "object",
      required: ["report", "patientId", "testId", "addedAt"],
      properties: {
        report: { type: "object", description: "Report data keyed by schema field name" },
        patientId: { type: "string", minLength: 24, maxLength: 24, description: "ObjectId of the admission" },
        testId: { type: "string", minLength: 24, maxLength: 24, description: "ObjectId of the test" },
        addedAt: { type: "integer", description: "Timestamp identifying this test entry among duplicates" },
      },
    },
  },
};

const updateDatesSchema = {
  schema: {
    tags: ["Indoor Reports"],
    summary: "Update sample collection / report dates for a specific entry",
    body: {
      type: "object",
      required: ["patientId", "testId", "addedAt"],
      properties: {
        patientId: { type: "string", minLength: 24, maxLength: 24, description: "ObjectId of the admission" },
        testId: { type: "string", minLength: 24, maxLength: 24, description: "ObjectId of the test" },
        addedAt: { type: "integer", description: "Timestamp identifying this test entry among duplicates" },
        sampleCollectionDate: { type: "integer", description: "Unix timestamp (ms) of sample collection" },
        reportDate: { type: "integer", description: "Unix timestamp (ms) the report was finalized" },
      },
    },
  },
};

const getReportSchema = {
  schema: {
    tags: ["Indoor Reports"],
    summary: "Get a report entry for a test on an admission",
    params: {
      type: "object",
      required: ["patientId", "testId"],
      properties: {
        patientId: { type: "string", minLength: 24, maxLength: 24, description: "ObjectId of the admission" },
        testId: { type: "string", minLength: 24, maxLength: 24, description: "ObjectId of the test" },
      },
    },
    querystring: {
      type: "object",
      properties: {
        addedAt: { type: "integer", description: "Timestamp selecting a specific entry among duplicates" },
      },
    },
  },
};

// ─── Routes ───────────────────────────────────────────────────────────────────

async function indoorReportRoutes(fastify) {
  const col = () => fastify.mongo.db.collection(COLLECTION);
  const testsCollection = () => fastify.mongo.db.collection("tests");
  const labId = (req) => toObjectId(req.user.labId);
  const by = (req) => ({ id: toObjectId(req.user.id), name: req.user.name });

  // This lab's custom reference range / value / unit overrides for a test,
  // limited to the format (schemaId) the entry is on.
  const getTestOverrides = async (req, testId, schemaId) => {
    if (!schemaId) return [];
    const doc = await testsCollection().findOne(
      { labId: labId(req), testId: toObjectId(testId) },
      { projection: { "schema.overrides": 1 } },
    );
    return (doc?.schema?.overrides ?? []).filter((o) => String(o.schemaId) === String(schemaId));
  };

  fastify.addHook("onRequest", fastify.authenticate);

  fastify.addHook("onRequest", async (req, reply) => {
    if (req.user.type !== "hospital") {
      return reply.code(403).send({ error: "Indoor patient management is only available for hospital labs" });
    }
  });

  const requireDownload = { onRequest: [fastify.authorize("testReportDownload")] };
  const requireUpload = { onRequest: [fastify.authorize("testReportUpload")] };

  // ── GET patient Data /indoorReport/:admissionId ────────────────────────
  fastify.get(
    "/indoorReport/:admissionId",
    {
      schema: {
        tags: ["IndoorPatients"],
        summary: "Get indoor patient by human-readable admission ID",
        params: {
          type: "object",
          required: ["admissionId"],
          additionalProperties: false,
          properties: {
            admissionId: {
              type: "string",
              pattern: "^[Ii][Pp][1-9]{3}[A-NP-Za-np-z]{2}$",
              minLength: 7,
              maxLength: 7,
            },
          },
        },
      },
    },
    async (req, reply) => {
      try {
        const patient = await fastify.mongo.db.collection("indoorPatients").findOne(
          { admissionId: req.params.admissionId.toUpperCase(), ...notDeletedFilter(req) },
          {
            projection: {
              admissionId: 1,
              status: 1,
              patient: 1,
              reports: 1,
            },
          },
        );
        if (!patient) return reply.code(404).send({ error: "Indoor patient not found" });
        return reply.send(patient);
      } catch (err) {
        req.log.error(err);
        return reply.code(500).send({ error: "Failed to fetch indoor patient" });
      }
    },
  );

  // ── POST /indoorReport/add ─────────────────────────────────────────────
  // Targets the first incomplete entry for this test — no addedAt needed.
  fastify.post("/indoorReport/add", { ...addReportSchema, ...requireUpload }, async (req, reply) => {
    try {
      const { report, patientId, testId } = req.body;

      const _id = toObjectId(patientId);
      if (!_id) return reply.code(400).send({ error: "Invalid patient ID" });

      const admission = await col().findOne({ _id, labId: labId(req) });
      if (!admission) return reply.code(404).send({ error: "Indoor patient not found" });

      const reportIndex = (admission.reports ?? []).findIndex(
        (r) => r.testId?.toString() === testId.toString() && !r.isCompleted,
      );
      if (reportIndex === -1) {
        return reply.code(404).send({ error: "No pending report entry found for this test on this admission" });
      }

      const reportEntry = admission.reports[reportIndex];
      if (!reportEntry.schemaId) {
        return reply.code(400).send({ error: "This test is offline and does not support report upload" });
      }

      const uploadedAt = Date.now();

      // On first upload, reportDate is hardcoded to the moment of upload —
      // it's not client-supplied and isn't inherited from any prior value.
      // sampleCollectionDate is preserved from whatever's already stored
      // (set at expense-add time, or since overridden via PUT /indoorReport/dates).
      const reportWithDates = {
        ...report,
        ...(reportEntry.report?.sampleCollectionDate !== undefined && {
          sampleCollectionDate: reportEntry.report.sampleCollectionDate,
        }),
        reportDate: uploadedAt,
      };

      const result = await col().updateOne(
        { _id, labId: labId(req) },
        {
          $set: {
            [`reports.${reportIndex}.report`]: reportWithDates,
            [`reports.${reportIndex}.isCompleted`]: true,
            [`reports.${reportIndex}.completedAt`]: uploadedAt,
            [`reports.${reportIndex}.completedBy`]: by(req),
          },
        },
      );

      if (result.modifiedCount === 0) return reply.code(400).send({ error: "Failed to save report" });
      return reply.code(201).send({ success: true });
    } catch (error) {
      req.log.error(error);
      return reply.code(500).send({ error: "Failed to add report" });
    }
  });

  // ── PUT /indoorReport/update ───────────────────────────────────────────
  // addedAt disambiguates when the same test appears multiple times.
  fastify.put("/indoorReport/update", { ...updateReportSchema, ...requireUpload }, async (req, reply) => {
    try {
      const { report, patientId, testId, addedAt } = req.body;

      const _id = toObjectId(patientId);
      if (!_id) return reply.code(400).send({ error: "Invalid patient ID" });

      const admission = await col().findOne({ _id, labId: labId(req) });
      if (!admission) return reply.code(404).send({ error: "Indoor patient not found" });

      const reportIndex = findReportIndex(admission.reports, testId, addedAt);
      if (reportIndex === -1) {
        return reply.code(404).send({ error: "Report entry not found for this test on this admission" });
      }

      const reportEntry = admission.reports[reportIndex];
      if (!reportEntry.schemaId) {
        return reply.code(400).send({ error: "This test is offline and does not support report upload" });
      }

      const reportWithDates = mergeReportDates(reportEntry.report, report);

      const result = await col().updateOne(
        { _id, labId: labId(req) },
        {
          $set: {
            [`reports.${reportIndex}.report`]: reportWithDates,
            [`reports.${reportIndex}.isCompleted`]: true,
            [`reports.${reportIndex}.updatedAt`]: Date.now(),
            [`reports.${reportIndex}.updatedBy`]: by(req),
          },
        },
      );

      if (result.modifiedCount === 0) return reply.code(400).send({ error: "Failed to update report" });
      return reply.send({ success: true });
    } catch (error) {
      req.log.error(error);
      return reply.code(500).send({ error: "Failed to update report" });
    }
  });

  // ── PUT /indoorReport/dates ────────────────────────────────────────────
  // Works regardless of whether the report has been submitted yet — parity
  // with outdoor's /report/dates.
  fastify.put("/indoorReport/dates", { ...updateDatesSchema, ...requireUpload }, async (req, reply) => {
    try {
      const { patientId, testId, addedAt, sampleCollectionDate, reportDate } = req.body;

      if (sampleCollectionDate === undefined && reportDate === undefined) {
        return reply.code(400).send({ error: "At least one of sampleCollectionDate or reportDate is required" });
      }

      const _id = toObjectId(patientId);
      if (!_id) return reply.code(400).send({ error: "Invalid patient ID" });

      const admission = await col().findOne({ _id, labId: labId(req) });
      if (!admission) return reply.code(404).send({ error: "Indoor patient not found" });

      const reportIndex = findReportIndex(admission.reports, testId, addedAt);
      if (reportIndex === -1) {
        return reply.code(404).send({ error: "Report entry not found for this test on this admission" });
      }

      if (!admission.reports[reportIndex].schemaId) {
        return reply.code(400).send({ error: "This test is offline and does not support report dates" });
      }

      const dateFields = {};
      if (sampleCollectionDate !== undefined) {
        dateFields[`reports.${reportIndex}.report.sampleCollectionDate`] = sampleCollectionDate;
      }
      if (reportDate !== undefined) {
        dateFields[`reports.${reportIndex}.report.reportDate`] = reportDate;
      }

      const result = await col().updateOne({ _id, labId: labId(req) }, { $set: dateFields });

      if (result.modifiedCount === 0) return reply.code(400).send({ error: "Failed to update dates" });
      return reply.send({ success: true });
    } catch (error) {
      req.log.error(error);
      return reply.code(500).send({ error: "Failed to update dates" });
    }
  });

  // ── GET /indoorReport/:patientId/:testId?addedAt= ─────────────────────
  // addedAt query param selects a specific entry when duplicates exist;
  // omitted, falls back to the first completed entry, else the first entry.
  fastify.get("/indoorReport/:patientId/:testId", { ...getReportSchema, ...requireDownload }, async (req, reply) => {
    try {
      const { patientId, testId } = req.params;
      const { addedAt } = req.query;

      const _id = toObjectId(patientId);
      if (!_id) return reply.code(400).send({ error: "Invalid patient ID" });

      const admission = await col().findOne({ _id, labId: labId(req) });
      if (!admission) return reply.code(404).send({ error: "Indoor patient not found" });

      const matches = (admission.reports ?? []).filter((r) => r.testId?.toString() === testId.toString());

      const reportEntry = addedAt
        ? matches.find((r) => r.addedAt === Number(addedAt))
        : (matches.find((r) => r.isCompleted) ?? matches[0]);

      if (!reportEntry) {
        return reply.code(404).send({ error: "Report entry not found for this test on this admission" });
      }

      const overrides = await getTestOverrides(req, testId, reportEntry.schemaId);

      return reply.send({
        testId: reportEntry.testId,
        testName: reportEntry.name,
        schemaId: reportEntry.schemaId,
        addedAt: reportEntry.addedAt,
        overrides,
        ...(reportEntry.schemaId && {
          report: reportEntry.report,
          isCompleted: reportEntry.isCompleted,
          completedAt: reportEntry.completedAt ?? null,
          completedBy: reportEntry.completedBy ?? null,
          updatedAt: reportEntry.updatedAt ?? null,
          updatedBy: reportEntry.updatedBy ?? null,
          reportDate: reportEntry.report?.reportDate ?? null,
          sampleCollectionDate: reportEntry.report?.sampleCollectionDate ?? null,
        }),
        patient: admission.patient,
        referrer: admission.referrer,
        admissionId: admission.admissionId,
      });
    } catch (error) {
      req.log.error(error);
      return reply.code(500).send({ error: "Failed to fetch report" });
    }
  });
}

export default indoorReportRoutes;
