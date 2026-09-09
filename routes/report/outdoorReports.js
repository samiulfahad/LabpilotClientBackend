/**
 * outdoorReportRoutes.js
 *
 * Structure mirrors invoiceRoutes.js: Constants → Helpers → Route Schemas → Routes.
 *
 * Cleanup notes:
 *  - GET /report/testSchema/:schemaId is intentionally left WITHOUT a permission
 *    gate and WITHOUT a labId filter — testSchemas is shared reference data (report
 *    templates), not a lab-scoped collection, so there's nothing tenant-specific to
 *    leak by _id lookup. Revisit only if testSchemas ever becomes lab-owned.
 *  - All other routes (add, update, dates, get-by-invoice) are gated on
 *    testReportUpload / testReportDownload, unchanged.
 *  - invoiceId validation matches invoiceRoutes.js's invoiceIdParamSchema:
 *    purely numeric, 6-10 digits (ddmm + per-lab daily sequence, e.g.
 *    "090901", overflowing to "0909100" past 99/day). Previously this file
 *    used a stale fixed-length (7 char) string check.
 *  - Every invoice lookup now distinguishes "doesn't exist" (404) from
 *    "exists but soft-deleted" (410, body includes `deleted: true`) via
 *    findReportableInvoice() below, instead of treating both as a plain
 *    404 (which itself was previously not checked at all — a deleted
 *    invoice's tests could be viewed/reported on through this file even
 *    though it's hidden from invoice/all and invoice/search).
 *  - GET /outdoorReport/:invoiceId's projection must include
 *    "deletion.status": 1. findReportableInvoice's soft-delete check reads
 *    invoice.deletion?.status — under a projection that omits it, Mongo
 *    strips the field entirely and the check silently no-ops, so a
 *    soft-deleted invoice was returned as if active (search "found" it
 *    fine; only add/update/dates, which fetch the full doc with no
 *    projection, correctly 410'd).
 */

import toObjectId from "../../utils/db.js";

// ─── Helpers ──────────────────────────────────────────────────────────────────

const findTestIndex = (tests, testId) => (tests ?? []).findIndex((t) => t.testId.toString() === testId.toString());

// sampleCollectionDate/reportDate are set independently of the report body
// (via PUT /report/dates) and must survive being overwritten whenever the
// report content itself is added or updated.
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

// invoiceId is "ddmm" (Asia/Dhaka) + a per-lab, per-day sequence number
// zero-padded to at least 2 digits, e.g. "090901" ... "0909100" past 99/day.
// Purely numeric, 6-10 digits. Kept in sync with invoiceIdParamSchema in
// invoiceRoutes.js.
const invoiceIdPropertySchema = {
  type: "string",
  pattern: "^[0-9]{6,10}$",
  minLength: 6,
  maxLength: 10,
  description: "Sequential invoice ID: ddmm + per-lab daily sequence number (e.g. 090901)",
};

const getSchemaParamSchema = {
  schema: {
    tags: ["Outdoor Reports"],
    summary: "Get a test report schema by ID",
    params: {
      type: "object",
      required: ["schemaId"],
      properties: {
        schemaId: { type: "string", minLength: 24, maxLength: 24, description: "ObjectId of the schema" },
      },
    },
  },
};

const addReportSchema = {
  schema: {
    tags: ["Outdoor Reports"],
    summary: "Add a report to a not-yet-completed test on an invoice",
    body: {
      type: "object",
      required: ["report", "invoiceId", "testId"],
      properties: {
        report: { type: "object", description: "Report data keyed by schema field name" },
        invoiceId: invoiceIdPropertySchema,
        testId: { type: "string", minLength: 24, maxLength: 24, description: "ObjectId of the test" },
      },
    },
  },
};

const updateReportSchema = {
  schema: {
    tags: ["Outdoor Reports"],
    summary: "Update the report for a test on an invoice",
    body: {
      type: "object",
      required: ["report", "invoiceId", "testId"],
      properties: {
        report: { type: "object", description: "Report data keyed by schema field name" },
        invoiceId: invoiceIdPropertySchema,
        testId: { type: "string", minLength: 24, maxLength: 24, description: "ObjectId of the test" },
      },
    },
  },
};

const updateDatesSchema = {
  schema: {
    tags: ["Outdoor Reports"],
    summary: "Update sample collection / report dates for a test — works before or after report submission",
    body: {
      type: "object",
      required: ["invoiceId", "testId"],
      properties: {
        invoiceId: invoiceIdPropertySchema,
        testId: { type: "string", minLength: 24, maxLength: 24, description: "ObjectId of the test" },
        sampleCollectionDate: { type: "integer", description: "Unix timestamp (ms) of sample collection" },
        reportDate: { type: "integer", description: "Unix timestamp (ms) the report was finalized" },
      },
    },
  },
};

const getReportSchema = {
  schema: {
    tags: ["Outdoor Reports"],
    summary: "Get the report + patient info for a test on an invoice",
    params: {
      type: "object",
      required: ["invoiceId", "testId"],
      properties: {
        invoiceId: invoiceIdPropertySchema,
        testId: { type: "string", minLength: 24, maxLength: 24, description: "ObjectId of the test" },
      },
    },
  },
};

// ─── Routes ───────────────────────────────────────────────────────────────────

async function outdoorReportRoutes(fastify) {
  const invoicesCollection = () => fastify.mongo.db.collection("invoices");
  const labId = (req) => toObjectId(req.user.labId);
  const by = (req) => ({ id: toObjectId(req.user.id), name: req.user.name });

  // Looks up an invoice by invoiceId + labId (no deletion filter, so we can
  // tell the two failure cases apart) and sends the appropriate error reply
  // itself: 404 if it doesn't exist at all, 410 with `deleted: true` if it
  // exists but was soft-deleted — a distinct signal so the frontend can show
  // "this invoice was deleted" instead of a generic not-found. Returns the
  // invoice doc on success, or `undefined` after already sending a reply —
  // callers must `return` immediately when the result is falsy.
  //
  // IMPORTANT: any caller that passes a `projection` MUST include
  // "deletion.status": 1 in it, or this check silently no-ops (see file
  // header note).
  const findReportableInvoice = async (req, reply, invoiceId, projection) => {
    const invoice = await invoicesCollection().findOne(
      { invoiceId, labId: labId(req) },
      projection ? { projection } : undefined,
    );
    if (!invoice) {
      reply.code(404).send({ error: "Invoice not found" });
      return undefined;
    }
    if (invoice.deletion?.status) {
      reply.code(410).send({ error: "This invoice has been deleted", deleted: true });
      return undefined;
    }
    return invoice;
  };

  fastify.addHook("onRequest", fastify.authenticate);

  const requireDownload = { onRequest: [fastify.authorize("testReportDownload")] };
  const requireUpload = { onRequest: [fastify.authorize("testReportUpload")] };

  // GET Patient
  fastify.get("/outdoorReport/:invoiceId", async (req, reply) => {
    try {
      const { invoiceId } = req.params;
      const invoice = await findReportableInvoice(req, reply, invoiceId, {
        _id: 0,
        invoiceId: 1,
        createdAt: 1,
        "patient.name": 1,
        "patient.gender": 1,
        "patient.age": 1,
        "patient.contactNumber": 1,
        "amount.initial": 1,
        "amount.final": 1,
        "amount.paid": 1,
        "tests.testId": 1,
        "tests.name": 1,
        "tests.price": 1,
        "tests.schemaId": 1,
        "tests.isCompleted": 1,
        "tests.report.sampleCollectionDate": 1,
        "tests.report.reportDate": 1,
        // Previously missing — MetaModal on the frontend reads these
        // four fields to show "Created by" / "Last edited by" in the
        // details tab. Without them here, Mongo strips the fields from
        // every response and the UI always shows "তথ্য নেই" (no info)
        // regardless of whether the report was actually uploaded/edited.
        "tests.completedAt": 1,
        "tests.completedBy": 1,
        "tests.updatedAt": 1,
        "tests.updatedBy": 1,
        paymentMode: 1,
        // Required so findReportableInvoice's soft-delete check can
        // actually see the field — see helper's doc comment.
        "deletion.status": 1,
      });
      if (!invoice) return;
      return reply.send(invoice);
    } catch (err) {
      req.log.error(err);
      return reply.code(500).send({ error: "Failed to fetch invoice summary" });
    }
  });

  // ── GET /report/testSchema/:schemaId ────────────────────────────────────
  fastify.get("/outdoorReport/testSchema/:schemaId", getSchemaParamSchema, async (req, reply) => {
    try {
      const _id = toObjectId(req.params.schemaId);
      if (!_id) return reply.code(400).send({ error: "Invalid schema ID" });

      const schema = await fastify.mongo.db.collection("testSchemas").findOne({ _id });
      if (!schema) return reply.code(404).send({ error: "Schema not found" });
      return reply.send(schema);
    } catch (err) {
      req.log.error(err);
      return reply.code(500).send({ error: "Failed to fetch schema" });
    }
  });

  // ── POST /report/add ────────────────────────────────────────────────────
  fastify.post("/outdoorReport/add", { ...addReportSchema, ...requireUpload }, async (req, reply) => {
    try {
      const { report, invoiceId, testId } = req.body;

      const invoice = await findReportableInvoice(req, reply, invoiceId);
      if (!invoice) return;

      const testIndex = findTestIndex(invoice.tests, testId);
      if (testIndex === -1) return reply.code(404).send({ error: "Test not found in this invoice" });

      if (invoice.tests[testIndex].isCompleted) {
        return reply.code(400).send({ error: "Report already submitted for this test. Use update instead." });
      }

      const uploadedAt = Date.now();

      // On first upload, reportDate is hardcoded to the moment of upload —
      // it's not client-supplied and isn't inherited from any prior value.
      // sampleCollectionDate is preserved from whatever's already stored
      // (defaulted to invoice.createdAt at invoice creation, or since
      // overridden via PUT /report/dates).
      const reportWithDates = {
        ...report,
        ...(invoice.tests[testIndex].report?.sampleCollectionDate !== undefined && {
          sampleCollectionDate: invoice.tests[testIndex].report.sampleCollectionDate,
        }),
        reportDate: uploadedAt,
      };

      const result = await invoicesCollection().updateOne(
        { invoiceId, labId: labId(req) },
        {
          $set: {
            [`tests.${testIndex}.report`]: reportWithDates,
            [`tests.${testIndex}.isCompleted`]: true,
            [`tests.${testIndex}.completedAt`]: uploadedAt,
            [`tests.${testIndex}.completedBy`]: by(req),
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

  // ── PUT /report/update ──────────────────────────────────────────────────
  fastify.put("/outdoorReport/update", { ...updateReportSchema, ...requireUpload }, async (req, reply) => {
    try {
      const { report, invoiceId, testId } = req.body;

      const invoice = await findReportableInvoice(req, reply, invoiceId);
      if (!invoice) return;

      const testIndex = findTestIndex(invoice.tests, testId);
      if (testIndex === -1) return reply.code(404).send({ error: "Test not found in this invoice" });

      const reportWithDates = mergeReportDates(invoice.tests[testIndex].report, report);

      const result = await invoicesCollection().updateOne(
        { invoiceId, labId: labId(req) },
        {
          $set: {
            [`tests.${testIndex}.report`]: reportWithDates,
            [`tests.${testIndex}.isCompleted`]: true,
            [`tests.${testIndex}.updatedAt`]: Date.now(),
            [`tests.${testIndex}.updatedBy`]: by(req),
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

  // ── PUT /report/dates ───────────────────────────────────────────────────
  // Works regardless of whether the report has been submitted yet.
  fastify.put("/outdoorReport/dates", { ...updateDatesSchema, ...requireUpload }, async (req, reply) => {
    try {
      const { invoiceId, testId, sampleCollectionDate, reportDate } = req.body;

      if (sampleCollectionDate === undefined && reportDate === undefined) {
        return reply.code(400).send({ error: "At least one of sampleCollectionDate or reportDate is required" });
      }

      const invoice = await findReportableInvoice(req, reply, invoiceId);
      if (!invoice) return;

      const testIndex = findTestIndex(invoice.tests, testId);
      if (testIndex === -1) return reply.code(404).send({ error: "Test not found in this invoice" });

      // Parity with indoor-report/dates — offline tests (no schemaId) don't support report dates.
      if (!invoice.tests[testIndex].schemaId) {
        return reply.code(400).send({ error: "This test is offline and does not support report dates" });
      }

      const dateFields = {};
      if (sampleCollectionDate !== undefined) {
        dateFields[`tests.${testIndex}.report.sampleCollectionDate`] = sampleCollectionDate;
      }
      if (reportDate !== undefined) {
        dateFields[`tests.${testIndex}.report.reportDate`] = reportDate;
      }

      const result = await invoicesCollection().updateOne({ invoiceId, labId: labId(req) }, { $set: dateFields });
      if (result.modifiedCount === 0) return reply.code(400).send({ error: "Failed to update dates" });
      return reply.send({ success: true });
    } catch (error) {
      req.log.error(error);
      return reply.code(500).send({ error: "Failed to update dates" });
    }
  });

  // ── GET /report/:invoiceId/:testId ──────────────────────────────────────
  // Returns the report + patient info from the parent invoice.
  fastify.get("/outdoorReport/:invoiceId/:testId", { ...getReportSchema, ...requireDownload }, async (req, reply) => {
    try {
      const { invoiceId, testId } = req.params;

      const invoice = await findReportableInvoice(req, reply, invoiceId);
      if (!invoice) return;

      const test = invoice.tests.find((t) => t.testId.toString() === testId.toString());
      if (!test) return reply.code(404).send({ error: "Test not found in this invoice" });

      return reply.send({
        report: test.report,
        isCompleted: test.isCompleted,
        completedAt: test.completedAt ?? null,
        completedBy: test.completedBy ?? null,
        updatedAt: test.updatedAt ?? null,
        updatedBy: test.updatedBy ?? null,
        patient: invoice.patient,
        referrer: invoice.referrer,
        invoiceId: invoice.invoiceId,
        testName: test.name,
        schemaId: test.schemaId,
        reportDate: test.report?.reportDate ?? null,
        sampleCollectionDate: test.report?.sampleCollectionDate ?? null,
      });
    } catch (error) {
      req.log.error(error);
      return reply.code(500).send({ error: "Failed to fetch report" });
    }
  });
}

export default outdoorReportRoutes;
