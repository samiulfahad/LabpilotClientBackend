import toObjectId from "../../utils/db.js";

const summaryQuerySchema = {
  schema: {
    tags: ["Discount Report"],
    summary:
      "Get discount and lab-adjustment totals grouped by staff, and discount totals grouped by referrer, for a date range",
    querystring: {
      type: "object",
      required: ["startDate", "endDate"],
      additionalProperties: false,
      properties: {
        startDate: { type: "integer", description: "Start date as Unix timestamp (ms)" },
        endDate: { type: "integer", description: "End date as Unix timestamp (ms)" },
      },
    },
  },
};

async function discountReportRoutes(fastify) {
  const col = () => fastify.mongo.db.collection("invoices");
  const indoorCol = () => fastify.mongo.db.collection("indoorPatients");
  const labId = (req) => toObjectId(req.user.labId);

  const notDeletedFilter = (req) => ({ labId: labId(req), "deletion.at": null });

  fastify.addHook("onRequest", fastify.authenticate);
  fastify.addHook("onRequest", fastify.authorize("discountReport"));

  fastify.get("/discount-report/summary", summaryQuerySchema, async (req, reply) => {
    const startDate = parseInt(req.query.startDate);
    const endDate = parseInt(req.query.endDate);

    if (startDate > endDate) return reply.code(400).send({ error: "startDate must be before endDate" });

    const isHospital = req.user.type === "hospital";

    try {
      // ── Discount stats per staff (OPD invoices) ──────────────────────────
      // Each line item now also carries the invoice's referrer id/name so
      // the staff-wise drill-down can show "who the discount was for", not
      // just "who entered it".
      const discountStatsPipeline = [
        {
          $match: {
            labId: labId(req),
            "deletion.status": false,
            createdAt: { $gte: startDate, $lte: endDate },
            "amount.referrerDiscount": { $gt: 0 },
          },
        },
        {
          $group: {
            _id: "$createdBy.id",
            staffName: { $last: "$createdBy.name" },
            totalDiscount: { $sum: "$amount.referrerDiscount" },
            invoices: {
              $push: {
                invoiceId: "$invoiceId",
                patient: "$patient.name",
                amount: "$amount.referrerDiscount",
                at: "$createdAt",
                source: "opd",
                referrerId: "$referrer.id",
                referrerName: "$referrer.name",
              },
            },
          },
        },
        { $addFields: { invoices: { $slice: ["$invoices", 200] } } },
      ];

      // ── Lab adjustment stats per staff (OPD invoices only) ───────────────
      const labAdjustmentStatsPipeline = [
        {
          $match: {
            labId: labId(req),
            "deletion.status": false,
            createdAt: { $gte: startDate, $lte: endDate },
            "amount.labAdjustment": { $gt: 0 },
          },
        },
        {
          $group: {
            _id: "$createdBy.id",
            staffName: { $last: "$createdBy.name" },
            totalLabAdjustment: { $sum: "$amount.labAdjustment" },
            invoices: {
              $push: {
                invoiceId: "$invoiceId",
                patient: "$patient.name",
                amount: "$amount.labAdjustment",
                at: "$createdAt",
                source: "opd",
              },
            },
          },
        },
        { $addFields: { invoices: { $slice: ["$invoices", 200] } } },
      ];

      // ── Discount stats per referrer (OPD invoices only) ──────────────────
      // Groups by `referrer.id` when the invoice's referrer resolved to a
      // registered referrer document; otherwise falls back to a
      // name-keyed bucket (mirrors the doctor-field convention: a typed
      // name that didn't match a registered referrer still has `name` set
      // but `id: null`). IPD has no per-discount referrer identity
      // (`discounts[].providedBy` is just a hospital/doctor/referrer
      // category, not a specific referrer), so this is OPD-only.
      const referrerDiscountStatsPipeline = [
        {
          $match: {
            labId: labId(req),
            "deletion.status": false,
            createdAt: { $gte: startDate, $lte: endDate },
            "amount.referrerDiscount": { $gt: 0 },
          },
        },
        {
          $group: {
            _id: {
              $cond: [
                "$referrer.id",
                "$referrer.id",
                { $concat: ["name:", { $ifNull: ["$referrer.name", "__none__"] }] },
              ],
            },
            referrerName: { $last: "$referrer.name" },
            totalDiscount: { $sum: "$amount.referrerDiscount" },
            invoices: {
              $push: {
                invoiceId: "$invoiceId",
                patient: "$patient.name",
                amount: "$amount.referrerDiscount",
                at: "$createdAt",
                source: "opd",
                staffId: "$createdBy.id",
                staffName: "$createdBy.name",
              },
            },
          },
        },
        { $addFields: { invoices: { $slice: ["$invoices", 200] } } },
      ];

      // ── Discount stats per staff (IPD discounts) ─────────────────────────
      const indoorDiscountStatsPipeline = [
        {
          $match: {
            ...notDeletedFilter(req),
            admittedAt: { $gte: startDate - 90 * 24 * 60 * 60 * 1000, $lte: endDate },
          },
        },
        { $unwind: "$discounts" },
        { $match: { "discounts.appliedAt": { $gte: startDate, $lte: endDate } } },
        {
          $group: {
            _id: "$discounts.appliedBy.id",
            staffName: { $last: "$discounts.appliedBy.name" },
            totalDiscount: { $sum: "$discounts.amount" },
            patients: {
              $push: {
                admissionId: "$admissionId",
                patient: "$patient.name",
                category: "$discounts.category",
                providedBy: "$discounts.providedBy",
                amount: "$discounts.amount",
                at: "$discounts.appliedAt",
                source: "ipd",
              },
            },
          },
        },
        { $addFields: { patients: { $slice: ["$patients", 200] } } },
      ];

      const [opdDiscountRows, labAdjustmentRows, referrerDiscountRows, ipdDiscountRows] = await Promise.all([
        col().aggregate(discountStatsPipeline, { allowDiskUse: true }).toArray(),
        col().aggregate(labAdjustmentStatsPipeline, { allowDiskUse: true }).toArray(),
        col().aggregate(referrerDiscountStatsPipeline, { allowDiskUse: true }).toArray(),
        isHospital ? indoorCol().aggregate(indoorDiscountStatsPipeline, { allowDiskUse: true }).toArray() : [],
      ]);

      // ── Merge OPD discount + lab adjustment + IPD discount rows by staff id ──
      const discountMap = new Map();

      for (const row of opdDiscountRows) {
        discountMap.set(String(row._id), {
          staffName: row.staffName,
          opdDiscount: row.totalDiscount,
          ipdDiscount: 0,
          labAdjustment: 0,
          invoices: [...row.invoices],
          patients: [],
          labAdjustmentInvoices: [],
        });
      }

      for (const row of labAdjustmentRows) {
        const key = String(row._id);
        const existing = discountMap.get(key);
        if (existing) {
          existing.labAdjustment += row.totalLabAdjustment;
          existing.labAdjustmentInvoices.push(...row.invoices);
          existing.staffName = existing.staffName ?? row.staffName;
        } else {
          discountMap.set(key, {
            staffName: row.staffName,
            opdDiscount: 0,
            ipdDiscount: 0,
            labAdjustment: row.totalLabAdjustment,
            invoices: [],
            patients: [],
            labAdjustmentInvoices: [...row.invoices],
          });
        }
      }

      for (const row of ipdDiscountRows) {
        const key = String(row._id);
        const existing = discountMap.get(key);
        if (existing) {
          existing.ipdDiscount += row.totalDiscount;
          existing.patients.push(...row.patients);
          existing.staffName = existing.staffName ?? row.staffName;
        } else {
          discountMap.set(key, {
            staffName: row.staffName,
            opdDiscount: 0,
            ipdDiscount: row.totalDiscount,
            labAdjustment: 0,
            invoices: [],
            patients: [...row.patients],
            labAdjustmentInvoices: [],
          });
        }
      }

      const staff = [];
      for (const [staffId, row] of discountMap) {
        row.invoices.sort((a, b) => a.at - b.at);
        row.patients.sort((a, b) => a.at - b.at);
        row.labAdjustmentInvoices.sort((a, b) => a.at - b.at);
        staff.push({
          staffId,
          name: row.staffName ?? "Unknown",
          totalDiscount: row.opdDiscount + row.ipdDiscount,
          opdDiscount: row.opdDiscount,
          ipdDiscount: row.ipdDiscount,
          labAdjustment: row.labAdjustment,
          invoices: row.invoices.slice(0, 200),
          patients: row.patients.slice(0, 200),
          labAdjustmentInvoices: row.labAdjustmentInvoices.slice(0, 200),
        });
      }
      staff.sort((a, b) => b.totalDiscount - a.totalDiscount);

      // ── Referrer-wise view (OPD discount only) ───────────────────────────
      const referrers = referrerDiscountRows.map((row) => ({
        referrerId: String(row._id),
        name: row.referrerName || "রেফারার ছাড়া",
        totalDiscount: row.totalDiscount,
        invoices: [...row.invoices].sort((a, b) => a.at - b.at).slice(0, 200),
      }));
      referrers.sort((a, b) => b.totalDiscount - a.totalDiscount);

      const totals = staff.reduce(
        (acc, s) => ({
          totalDiscount: acc.totalDiscount + s.totalDiscount,
          opdDiscount: acc.opdDiscount + s.opdDiscount,
          ipdDiscount: acc.ipdDiscount + s.ipdDiscount,
          labAdjustment: acc.labAdjustment + s.labAdjustment,
        }),
        { totalDiscount: 0, opdDiscount: 0, ipdDiscount: 0, labAdjustment: 0 },
      );

      return reply.send({ staff, referrers, totals });
    } catch (err) {
      req.log.error(err);
      return reply.code(500).send({ error: "Failed to fetch discount report" });
    }
  });
}

export default discountReportRoutes;
