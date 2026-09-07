import toObjectId from "../../utils/db.js";
import { computeTotalBilled, computeTotalDiscounts, computeTotalPayments } from "../../utils/ipdBilling.js";

// ─── Helpers ──────────────────────────────────────────────────────────────────

const PAYMENT_MODE_KEYS = ["cash", "bkash", "nagad", "card", "bank_transfer", "others"];

// Parses & validates startDate/endDate query params shared by every route
// below. Sends a 400 and returns null if invalid, so callers can just
// `const range = parseDateRange(req, reply); if (!range) return;`
const parseDateRange = (req, reply) => {
  const startDate = parseInt(req.query.startDate);
  const endDate = parseInt(req.query.endDate);

  if (Number.isNaN(startDate) || Number.isNaN(endDate)) {
    reply.code(400).send({ error: "startDate and endDate must be valid Unix timestamps (ms)" });
    return null;
  }
  if (startDate > endDate) {
    reply.code(400).send({ error: "startDate must be before endDate" });
    return null;
  }
  return { startDate, endDate };
};

// Flattens a Mongo group-by-mode aggregation result into the fixed-shape
// object the client expects — every PAYMENT_MODE_KEYS entry present, modes
// with no activity in range come back as 0. Shared by /cashmemo/summary and
// /cashmemo/ipd-summary.
const buildPaymentModeBreakdown = (rows) => {
  const breakdown = Object.fromEntries(PAYMENT_MODE_KEYS.map((k) => [k, 0]));
  for (const row of rows) {
    if (row._id && Object.prototype.hasOwnProperty.call(breakdown, row._id)) {
      breakdown[row._id] = Math.round(row.total);
    }
  }
  return breakdown;
};

const EMPTY_PAYMENT_MODE_BREAKDOWN = () => Object.fromEntries(PAYMENT_MODE_KEYS.map((k) => [k, 0]));

// Zeroed IPD summary shape returned for diagnosticCenter labs (no IPD module).
// Kept as one object so it can't drift out of sync with the real response shape.
const EMPTY_IPD_SUMMARY = () => ({
  currentlyAdmitted: 0,
  admittedCount: 0,
  releasedCount: 0,
  avgStayDays: 0,
  totalBilled: 0,
  categoryBreakdown: { test: 0, medicine: 0, product: 0, other: 0 },
  totalDiscounts: 0,
  discountCount: 0,
  discountPatientCount: 0,
  totalCollected: 0,
  totalCommission: 0,
  deletedCount: 0,
  totalAmountDeleted: 0,
  paymentModeBreakdown: EMPTY_PAYMENT_MODE_BREAKDOWN(),
});

// ─── Schemas ──────────────────────────────────────────────────────────────────

const summaryQuerySchema = {
  schema: {
    tags: ["Cashmemo"],
    summary: "Get cash memo summary for a date range",
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

// ── New: outdoor deleted-invoices drill-down schema ─────────────────────────
const outdoorDeletedInvoicesQuerySchema = {
  schema: {
    tags: ["Cashmemo"],
    summary: "Get invoice-level breakdown of soft-deleted outdoor invoices in a date range",
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

const ipdSummaryQuerySchema = {
  schema: {
    tags: ["Cashmemo"],
    summary:
      "Get IPD revenue-cycle summary for a date range — census, ALOS, billed/collected/due, collection rate, revenue by category, discounts, commission, deletions",
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

const ipdDiscountPatientsQuerySchema = {
  schema: {
    tags: ["Cashmemo"],
    summary: "Get patient-level breakdown of IPD discounts applied in a date range",
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

const ipdAdmittedPatientsQuerySchema = {
  schema: {
    tags: ["Cashmemo"],
    summary: "Get list of patients admitted within a date range",
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

const ipdReleasedPatientsQuerySchema = {
  schema: {
    tags: ["Cashmemo"],
    summary: "Get list of patients released within a date range",
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

const ipdOutstandingPatientsSchema = {
  schema: {
    tags: ["Cashmemo"],
    summary: "Get currently admitted patients with outstanding dues (AR), sorted highest due first",
  },
};

// ── New: deleted-patients drill-down schema ─────────────────────────────────
const ipdDeletedPatientsQuerySchema = {
  schema: {
    tags: ["Cashmemo"],
    summary: "Get patient-level breakdown of soft-deleted IPD admissions in a date range",
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

const expenseSummaryQuerySchema = {
  schema: {
    tags: ["Cashmemo"],
    summary: "Get total lab (operational) expense for a date range",
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

// ─── Routes ───────────────────────────────────────────────────────────────────

async function cashmemoRoutes(fastify) {
  const invoicesCol = () => fastify.mongo.db.collection("invoices");
  const ipdCol = () => fastify.mongo.db.collection("indoorPatients");
  const expenseCol = () => fastify.mongo.db.collection("expenses");
  const labId = (req) => toObjectId(req.user.labId);
  const isHospital = (req) => req.user.type === "hospital"; // diagnosticCenter labs have no IPD module

  // Every read against indoorPatients must exclude soft-deleted records, so
  // reporting/cashmemo figures never include patients that were deleted.
  // Missing `deletion` field (pre-soft-delete legacy docs) still matches null.
  const notDeletedFilter = (req) => ({ labId: labId(req), "deletion.at": null });

  // Soft-deleted admissions, scoped to a deletion timestamp range — used for
  // the "ডিলিট করা রোগী" figure and its drill-down, so deletions are reported
  // against the window they were deleted in (not the window they were admitted in).
  const deletedFilter = (req, startDate, endDate) => ({
    labId: labId(req),
    "deletion.at": { $ne: null, $gte: startDate, $lte: endDate },
  });

  fastify.addHook("onRequest", fastify.authenticate);
  fastify.addHook("onRequest", fastify.authorize("cashmemo"));

  // ── GET /cashmemo/summary ─────────────────────────────────────────────────
  //
  // Active-invoice figures (totalInvoices/initial/paid/etc.) are scoped by
  // createdAt in range — that's "business done in this window".
  //
  // Referrer commission is intentionally NOT computed here — it's calculated
  // in a separate module/endpoint now, so this summary only carries the raw
  // billing/collection figures.
  //
  // totalInvoiceFee sums amount.invoiceFee across active invoices created in
  // range — the online-report fee (added on top of the patient's total, per
  // the createdAt-scoped "business done in this window" convention as the
  // rest of this block, not activity-based like collections/deletions below).
  //
  // Deleted-invoice figures (deletedCount/totalAmountDeleted) are scoped by
  // deletion.at in range instead, NOT createdAt. A deletion is reported
  // against the window it happened in, regardless of when the invoice was
  // originally created — e.g. an invoice created 7 days ago but deleted today
  // must count in TODAY's deletedCount, not in the range it was created in.
  // This mirrors the IPD deletedFilter pattern and matches what the
  // /cashmemo/outdoor-deleted-invoices drill-down already does, so the header
  // count and the drill-down list never disagree.
  //
  // paymentModeBreakdown is scoped by collections.at in range (NOT createdAt
  // either) — same "activity-based" convention as the deletion figures and
  // the IPD payments/discounts aggregations below: a due collected today in
  // a given mode counts toward today's breakdown even if the invoice itself
  // was created earlier. Only non-deleted invoices contribute, matching the
  // rest of the active figures.
  fastify.get("/cashmemo/summary", summaryQuerySchema, async (req, reply) => {
    try {
      const range = parseDateRange(req, reply);
      if (!range) return;
      const { startDate, endDate } = range;

      const [activeResult, deletedResult, paymentModeResult] = await Promise.all([
        // ── Active invoices created in range ──────────────────────────────
        invoicesCol()
          .aggregate(
            [
              {
                $match: {
                  labId: labId(req),
                  createdAt: { $gte: startDate, $lte: endDate },
                  "deletion.status": false,
                },
              },
              {
                $group: {
                  _id: null,
                  totalInvoices: { $sum: 1 },
                  initial: { $sum: { $ifNull: ["$amount.initial", 0] } },
                  labAdjustment: { $sum: { $ifNull: ["$amount.labAdjustment", 0] } },
                  referrerDiscount: { $sum: { $ifNull: ["$amount.referrerDiscount", 0] } },
                  totalFinal: { $sum: { $ifNull: ["$amount.final", 0] } },
                  totalNet: { $sum: { $ifNull: ["$amount.net", 0] } },
                  totalPaid: { $sum: { $ifNull: ["$amount.paid", 0] } },
                  totalInvoiceFee: { $sum: { $ifNull: ["$amount.invoiceFee", 0] } },
                },
              },
              {
                $project: {
                  _id: 0,
                  totalInvoices: 1,
                  initial: 1,
                  labAdjustment: 1,
                  referrerDiscount: 1,
                  totalFinal: 1,
                  totalNet: 1,
                  totalPaid: 1,
                  totalInvoiceFee: 1,
                  totalDue: { $max: [0, { $subtract: ["$totalFinal", "$totalPaid"] }] },
                },
              },
            ],
            { allowDiskUse: true },
          )
          .toArray(),

        // ── Deleted invoices, scoped by deletion.at (NOT createdAt) ───────
        invoicesCol()
          .aggregate(
            [
              {
                $match: {
                  labId: labId(req),
                  "deletion.status": true,
                  "deletion.at": { $gte: startDate, $lte: endDate },
                },
              },
              {
                $group: {
                  _id: null,
                  deletedCount: { $sum: 1 },
                  totalAmountDeleted: { $sum: { $ifNull: ["$amount.initial", 0] } },
                },
              },
              { $project: { _id: 0, deletedCount: 1, totalAmountDeleted: 1 } },
            ],
            { allowDiskUse: true },
          )
          .toArray(),

        // ── Payment-mode breakdown — money actually collected in range ────
        // Scoped by collections.at (when the payment happened), not the
        // invoice's createdAt. Only non-deleted invoices contribute.
        invoicesCol()
          .aggregate(
            [
              { $match: { labId: labId(req), "deletion.status": false } },
              { $unwind: "$collections" },
              { $match: { "collections.at": { $gte: startDate, $lte: endDate } } },
              {
                $group: {
                  _id: "$collections.mode",
                  total: { $sum: "$collections.amount" },
                },
              },
            ],
            { allowDiskUse: true },
          )
          .toArray(),
      ]);

      const active = activeResult[0] ?? {
        totalInvoices: 0,
        initial: 0,
        labAdjustment: 0,
        referrerDiscount: 0,
        totalFinal: 0,
        totalNet: 0,
        totalPaid: 0,
        totalInvoiceFee: 0,
        totalDue: 0,
      };

      return reply.send({
        ...active,
        deletedCount: deletedResult[0]?.deletedCount ?? 0,
        totalAmountDeleted: deletedResult[0]?.totalAmountDeleted ?? 0,
        paymentModeBreakdown: buildPaymentModeBreakdown(paymentModeResult),
      });
    } catch (err) {
      req.log.error(err);
      return reply.code(500).send({ error: "Failed to fetch cash memo summary" });
    }
  });

  // ── GET /cashmemo/outdoor-deleted-invoices ────────────────────────────────
  // Invoice-level breakdown of soft-deleted outdoor invoices within the date
  // range (matched against deletion.at, so a deletion is reported against the
  // window it happened in, not the window the invoice was created in). Used
  // to drill into the "ডিলিট করা ইনভয়েস" figure on the outdoor cashmemo tab.
  // Mirrors the IPD deleted-patients endpoint but against the invoices collection.
  fastify.get("/cashmemo/outdoor-deleted-invoices", outdoorDeletedInvoicesQuerySchema, async (req, reply) => {
    try {
      const range = parseDateRange(req, reply);
      if (!range) return;
      const { startDate, endDate } = range;

      const invoices = await invoicesCol()
        .find(
          {
            labId: labId(req),
            "deletion.status": true,
            "deletion.at": { $gte: startDate, $lte: endDate },
          },
          {
            projection: {
              invoiceId: 1,
              patient: 1,
              amount: 1,
              deletion: 1,
              createdAt: 1,
            },
          },
        )
        .sort({ "deletion.at": -1 })
        .toArray();

      return reply.send({ invoices });
    } catch (err) {
      req.log.error(err);
      return reply.code(500).send({ error: "Failed to fetch deleted invoices" });
    }
  });

  // ── GET /cashmemo/ipd-summary ─────────────────────────────────────────────
  //
  // Revenue-cycle view for IPD, built around the metrics an actual hospital
  // finance dashboard tracks: current census, patient flow (admissions/
  // discharges), average length of stay, billed vs. collected vs. due,
  // collection rate, revenue mix by category, payment-mode breakdown,
  // referrer commission, and soft-deleted admissions.
  //
  //   revenue figures  → activity-based: expenses/discounts/payments whose
  //                      own timestamp (addedAt/appliedAt/collectedAt) falls
  //                      in [startDate, endDate]
  //   totalCommission  → sum of expenses[].commission for expenses added in
  //                      range (same activity-based window as totalBilled).
  //                      NOTE: unlike outdoor invoices, IPD admissions don't
  //                      store a referrer commission %, so there is no
  //                      percentage-based figure here — this is test-wise only.
  //   paymentModeBreakdown → same activity-based convention, scoped by
  //                      payments.collectedAt in range. Mirrors the outdoor
  //                      /cashmemo/summary paymentModeBreakdown exactly, just
  //                      sourced from indoorPatients.payments instead of
  //                      invoices.collections.
  //   admitted/released/ALOS → based on admittedAt/releasedAt in range
  //   currentlyAdmitted       → real-time census, NOT date-bound
  //   deletedCount/totalAmountDeleted → based on deletion.at in range (NOT
  //     admittedAt), so a patient admitted 7 days ago but deleted today counts
  //     in today's deletedCount, exactly like the outdoor summary above.
  //
  // All aggregations/queries below (except the deleted one, which is the
  // mirror-image) are scoped to non-deleted patients only (notDeletedFilter),
  // so a soft-deleted admission never contributes to billed/collected/
  // discount/commission/census/flow/paymentMode figures.
  //
  // NOTE: totalBilled reflects itemized expenses only (test/medicine/product/
  // service/other) — bed charges accrue daily rather than as dated ledger
  // entries, so they aren't attributable to a specific reporting window with
  // the current schema. Bed charge shows up in the per-patient outstanding
  // (AR) endpoint below, where it's computed against "as of now".
  //
  // IPD admissions have no invoiceFee concept (that's an outdoor-invoice-only
  // field) — no equivalent figure here.
  //
  // diagnosticCenter labs have no IPD module — short-circuit before ever
  // touching the indoorPatients collection for them.
  //
  // NOTE: this endpoint's totalCommission (IPD, test-wise, sourced from
  // indoorPatients.expenses[].commission) is a separate mechanism from the
  // outdoor referrer commission that used to live in /cashmemo/summary — it
  // was left untouched when that outdoor commission calc was moved out.
  fastify.get("/cashmemo/ipd-summary", ipdSummaryQuerySchema, async (req, reply) => {
    try {
      const range = parseDateRange(req, reply);
      if (!range) return;
      const { startDate, endDate } = range;

      if (!isHospital(req)) {
        return reply.send(EMPTY_IPD_SUMMARY());
      }

      const [
        expensesResult,
        discountsResult,
        paymentsResult,
        paymentModeResult,
        flowResult,
        currentlyAdmitted,
        deletedResult,
      ] = await Promise.all([
        // ── Expenses added in range — revenue mix by category + commission ─
        ipdCol()
          .aggregate(
            [
              { $match: notDeletedFilter(req) },
              { $unwind: "$expenses" },
              { $match: { "expenses.addedAt": { $gte: startDate, $lte: endDate } } },
              {
                $group: {
                  _id: null,
                  totalBilled: {
                    $sum: {
                      $ifNull: ["$expenses.total", { $multiply: ["$expenses.price", "$expenses.quantity"] }],
                    },
                  },
                  testAmount: {
                    $sum: {
                      $cond: [
                        { $eq: ["$expenses.type", "test"] },
                        { $ifNull: ["$expenses.total", { $multiply: ["$expenses.price", "$expenses.quantity"] }] },
                        0,
                      ],
                    },
                  },
                  medicineAmount: {
                    $sum: {
                      $cond: [
                        { $eq: ["$expenses.type", "medicine"] },
                        { $ifNull: ["$expenses.total", { $multiply: ["$expenses.price", "$expenses.quantity"] }] },
                        0,
                      ],
                    },
                  },
                  productAmount: {
                    $sum: {
                      $cond: [
                        { $eq: ["$expenses.type", "product"] },
                        { $ifNull: ["$expenses.total", { $multiply: ["$expenses.price", "$expenses.quantity"] }] },
                        0,
                      ],
                    },
                  },
                  otherAmount: {
                    $sum: {
                      $cond: [
                        { $in: ["$expenses.type", ["service", "other"]] },
                        { $ifNull: ["$expenses.total", { $multiply: ["$expenses.price", "$expenses.quantity"] }] },
                        0,
                      ],
                    },
                  },
                  commissionAmount: { $sum: { $ifNull: ["$expenses.commission", 0] } },
                },
              },
              {
                $project: {
                  _id: 0,
                  totalBilled: 1,
                  testAmount: 1,
                  medicineAmount: 1,
                  productAmount: 1,
                  otherAmount: 1,
                  commissionAmount: 1,
                },
              },
            ],
            { allowDiskUse: true },
          )
          .toArray(),

        // ── Discounts applied in range ────────────────────────────────────────
        ipdCol()
          .aggregate(
            [
              { $match: notDeletedFilter(req) },
              { $unwind: "$discounts" },
              { $match: { "discounts.appliedAt": { $gte: startDate, $lte: endDate } } },
              {
                $group: {
                  _id: null,
                  totalDiscounts: { $sum: "$discounts.amount" },
                  discountCount: { $sum: 1 },
                  discountPatientIds: { $addToSet: "$_id" },
                },
              },
              {
                $project: {
                  _id: 0,
                  totalDiscounts: 1,
                  discountCount: 1,
                  discountPatientCount: { $size: "$discountPatientIds" },
                },
              },
            ],
            { allowDiskUse: true },
          )
          .toArray(),

        // ── Payments collected in range ──────────────────────────────────────
        ipdCol()
          .aggregate(
            [
              { $match: notDeletedFilter(req) },
              { $unwind: "$payments" },
              { $match: { "payments.collectedAt": { $gte: startDate, $lte: endDate } } },
              {
                $group: {
                  _id: null,
                  totalCollected: { $sum: "$payments.amount" },
                  paymentCount: { $sum: 1 },
                },
              },
              { $project: { _id: 0, totalCollected: 1, paymentCount: 1 } },
            ],
            { allowDiskUse: true },
          )
          .toArray(),

        // ── Payment-mode breakdown — money actually collected in range ────
        // Mirrors the outdoor /cashmemo/summary paymentModeBreakdown pattern:
        // scoped by payments.collectedAt (activity-based, not admittedAt),
        // only non-deleted patients contribute.
        ipdCol()
          .aggregate(
            [
              { $match: notDeletedFilter(req) },
              { $unwind: "$payments" },
              { $match: { "payments.collectedAt": { $gte: startDate, $lte: endDate } } },
              {
                $group: {
                  _id: "$payments.mode",
                  total: { $sum: "$payments.amount" },
                },
              },
            ],
            { allowDiskUse: true },
          )
          .toArray(),

        // ── Patient flow: admitted / released in range, + ALOS for releases ──
        ipdCol()
          .aggregate(
            [
              { $match: notDeletedFilter(req) },
              {
                $facet: {
                  admitted: [{ $match: { admittedAt: { $gte: startDate, $lte: endDate } } }, { $count: "count" }],
                  released: [
                    { $match: { releasedAt: { $gte: startDate, $lte: endDate } } },
                    {
                      $project: {
                        stayDays: { $divide: [{ $subtract: ["$releasedAt", "$admittedAt"] }, 1000 * 60 * 60 * 24] },
                      },
                    },
                    { $group: { _id: null, count: { $sum: 1 }, avgStayDays: { $avg: "$stayDays" } } },
                  ],
                },
              },
            ],
            { allowDiskUse: true },
          )
          .toArray(),

        // ── Real-time census — not date-bound ─────────────────────────────────
        ipdCol().countDocuments({ ...notDeletedFilter(req), status: "admitted" }),

        // ── Deleted admissions in range (by deletion.at) — count + billed total ──
        ipdCol()
          .aggregate(
            [
              { $match: deletedFilter(req, startDate, endDate) },
              {
                $project: {
                  billed: {
                    $sum: {
                      $map: {
                        input: { $ifNull: ["$expenses", []] },
                        as: "e",
                        in: { $ifNull: ["$$e.total", { $multiply: ["$$e.price", "$$e.quantity"] }] },
                      },
                    },
                  },
                },
              },
              {
                $group: {
                  _id: null,
                  deletedCount: { $sum: 1 },
                  totalAmountDeleted: { $sum: "$billed" },
                },
              },
              { $project: { _id: 0, deletedCount: 1, totalAmountDeleted: 1 } },
            ],
            { allowDiskUse: true },
          )
          .toArray(),
      ]);

      const expenses = expensesResult[0] ?? {
        totalBilled: 0,
        testAmount: 0,
        medicineAmount: 0,
        productAmount: 0,
        otherAmount: 0,
        commissionAmount: 0,
      };
      const discounts = discountsResult[0] ?? { totalDiscounts: 0, discountCount: 0, discountPatientCount: 0 };
      const payments = paymentsResult[0] ?? { totalCollected: 0, paymentCount: 0 };
      const admittedCount = flowResult[0]?.admitted?.[0]?.count ?? 0;
      const releasedCount = flowResult[0]?.released?.[0]?.count ?? 0;
      const avgStayDays = flowResult[0]?.released?.[0]?.avgStayDays ?? 0;
      const deleted = deletedResult[0] ?? { deletedCount: 0, totalAmountDeleted: 0 };

      const totalBilled = Math.round(expenses.totalBilled);
      const totalDiscounts = Math.round(discounts.totalDiscounts);
      const totalCollected = Math.round(payments.totalCollected);
      const totalCommission = Math.round(expenses.commissionAmount);

      return reply.send({
        currentlyAdmitted,
        admittedCount,
        releasedCount,
        avgStayDays: Math.round(avgStayDays * 10) / 10,
        totalBilled,
        categoryBreakdown: {
          test: Math.round(expenses.testAmount),
          medicine: Math.round(expenses.medicineAmount),
          product: Math.round(expenses.productAmount),
          other: Math.round(expenses.otherAmount),
        },
        totalDiscounts,
        discountCount: discounts.discountCount,
        discountPatientCount: discounts.discountPatientCount,
        totalCollected,
        totalCommission,
        deletedCount: deleted.deletedCount,
        totalAmountDeleted: Math.round(deleted.totalAmountDeleted),
        paymentModeBreakdown: buildPaymentModeBreakdown(paymentModeResult),
      });
    } catch (err) {
      req.log.error(err);
      return reply.code(500).send({ error: "Failed to fetch IPD cash memo summary" });
    }
  });

  // ── GET /cashmemo/ipd-discount-patients ───────────────────────────────────
  // Patient-level breakdown of discounts applied within the date range, used
  // to drill into the "মোট ডিসকাউন্ট" figure on the indoor cashmemo tab.
  //
  // diagnosticCenter labs have no IPD module — return an empty list rather
  // than querying indoorPatients. Excludes soft-deleted patients.
  fastify.get("/cashmemo/ipd-discount-patients", ipdDiscountPatientsQuerySchema, async (req, reply) => {
    try {
      const range = parseDateRange(req, reply);
      if (!range) return;
      const { startDate, endDate } = range;

      if (!isHospital(req)) return reply.send({ patients: [] });

      const patients = await ipdCol()
        .aggregate(
          [
            { $match: notDeletedFilter(req) },
            { $unwind: "$discounts" },
            { $match: { "discounts.appliedAt": { $gte: startDate, $lte: endDate } } },
            {
              $group: {
                _id: "$_id",
                admissionId: { $first: "$admissionId" },
                patientName: { $first: "$patient.name" },
                totalDiscount: { $sum: "$discounts.amount" },
                discountCount: { $sum: 1 },
                discounts: {
                  $push: {
                    category: "$discounts.category",
                    amount: "$discounts.amount",
                    providedBy: "$discounts.providedBy",
                    note: "$discounts.note",
                    appliedAt: "$discounts.appliedAt",
                  },
                },
              },
            },
            { $sort: { totalDiscount: -1 } },
          ],
          { allowDiskUse: true },
        )
        .toArray();

      return reply.send({ patients });
    } catch (err) {
      req.log.error(err);
      return reply.code(500).send({ error: "Failed to fetch IPD discount patients" });
    }
  });

  // ── GET /cashmemo/ipd-admitted-patients ───────────────────────────────────
  // List of patients whose admittedAt falls within the date range, used to
  // drill into the "নতুন ভর্তি রোগী" count on the indoor cashmemo tab.
  //
  // diagnosticCenter labs have no IPD module — return an empty list rather
  // than querying indoorPatients. Excludes soft-deleted patients.
  fastify.get("/cashmemo/ipd-admitted-patients", ipdAdmittedPatientsQuerySchema, async (req, reply) => {
    try {
      const range = parseDateRange(req, reply);
      if (!range) return;
      const { startDate, endDate } = range;

      if (!isHospital(req)) return reply.send({ patients: [] });

      const patients = await ipdCol()
        .find(
          { ...notDeletedFilter(req), admittedAt: { $gte: startDate, $lte: endDate } },
          {
            projection: {
              admissionId: 1,
              status: 1,
              patient: 1,
              space: 1,
              supervisorDoctor: 1,
              dealType: 1,
              admittedAt: 1,
            },
          },
        )
        .sort({ admittedAt: -1 })
        .toArray();

      return reply.send({ patients });
    } catch (err) {
      req.log.error(err);
      return reply.code(500).send({ error: "Failed to fetch admitted patients" });
    }
  });

  // ── GET /cashmemo/ipd-released-patients ───────────────────────────────────
  // List of patients whose releasedAt falls within the date range, used to
  // drill into the "ছাড়প্রাপ্ত রোগী" count on the indoor cashmemo tab.
  //
  // diagnosticCenter labs have no IPD module — return an empty list rather
  // than querying indoorPatients. Excludes soft-deleted patients.
  fastify.get("/cashmemo/ipd-released-patients", ipdReleasedPatientsQuerySchema, async (req, reply) => {
    try {
      const range = parseDateRange(req, reply);
      if (!range) return;
      const { startDate, endDate } = range;

      if (!isHospital(req)) return reply.send({ patients: [] });

      const patients = await ipdCol()
        .find(
          { ...notDeletedFilter(req), releasedAt: { $gte: startDate, $lte: endDate } },
          {
            projection: {
              admissionId: 1,
              status: 1,
              patient: 1,
              space: 1,
              supervisorDoctor: 1,
              dealType: 1,
              admittedAt: 1,
              releasedAt: 1,
            },
          },
        )
        .sort({ releasedAt: -1 })
        .toArray();

      return reply.send({ patients });
    } catch (err) {
      req.log.error(err);
      return reply.code(500).send({ error: "Failed to fetch released patients" });
    }
  });

  // ── GET /cashmemo/ipd-outstanding-patients ────────────────────────────────
  // Accounts-receivable view: every currently-admitted patient with a
  // positive outstanding balance (billed − discounts − collected), sorted
  // highest due first. Not date-range bound — this is "as of right now",
  // same as any hospital AR aging screen.
  //
  // diagnosticCenter labs have no IPD module — return an empty list rather
  // than querying indoorPatients. Excludes soft-deleted patients.
  fastify.get("/cashmemo/ipd-outstanding-patients", ipdOutstandingPatientsSchema, async (req, reply) => {
    try {
      if (!isHospital(req)) return reply.send({ patients: [] });

      const admissions = await ipdCol()
        .find(
          { ...notDeletedFilter(req), status: "admitted" },
          {
            projection: {
              admissionId: 1,
              patient: 1,
              space: 1,
              wardHistory: 1,
              dealType: 1,
              packageDeal: 1,
              expenses: 1,
              discounts: 1,
              payments: 1,
              admittedAt: 1,
            },
          },
        )
        .toArray();

      const patients = admissions
        .map((a) => {
          const billed = computeTotalBilled(a);
          const discounted = computeTotalDiscounts(a.discounts);
          const collected = computeTotalPayments(a.payments);
          const due = Math.max(0, billed - discounted - collected);
          return {
            _id: a._id,
            admissionId: a.admissionId,
            patientName: a.patient?.name,
            spaceName: a.space?.spaceName,
            bedNumber: a.space?.bedNumber,
            admittedAt: a.admittedAt,
            billed: Math.round(billed),
            due: Math.round(due),
          };
        })
        .filter((p) => p.due > 0)
        .sort((a, b) => b.due - a.due);

      return reply.send({ patients });
    } catch (err) {
      req.log.error(err);
      return reply.code(500).send({ error: "Failed to fetch outstanding patients" });
    }
  });

  // ── GET /cashmemo/ipd-deleted-patients ────────────────────────────────────
  // Patient-level breakdown of soft-deleted admissions within the date range
  // (matched against deletion.at, so a deletion is reported against the
  // window it happened in, not the window the patient was admitted in). Used
  // to drill into the "ডিলিট করা রোগী" figure on the indoor cashmemo tab.
  //
  // diagnosticCenter labs have no IPD module — return an empty list rather
  // than querying indoorPatients.
  fastify.get("/cashmemo/ipd-deleted-patients", ipdDeletedPatientsQuerySchema, async (req, reply) => {
    try {
      const range = parseDateRange(req, reply);
      if (!range) return;
      const { startDate, endDate } = range;

      if (!isHospital(req)) return reply.send({ patients: [] });

      const admissions = await ipdCol()
        .find(deletedFilter(req, startDate, endDate), {
          projection: {
            admissionId: 1,
            patient: 1,
            space: 1,
            expenses: 1,
            payments: 1,
            deletion: 1,
            admittedAt: 1,
          },
        })
        .sort({ "deletion.at": -1 })
        .toArray();

      const patients = admissions.map((a) => {
        const billed = computeTotalBilled(a);
        const collected = computeTotalPayments(a.payments);
        return {
          _id: a._id,
          admissionId: a.admissionId,
          patientName: a.patient?.name,
          spaceName: a.space?.spaceName,
          bedNumber: a.space?.bedNumber,
          admittedAt: a.admittedAt,
          billed: Math.round(billed),
          collected: Math.round(collected),
          deletedAt: a.deletion?.at,
          deletedBy: a.deletion?.by?.name,
        };
      });

      return reply.send({ patients });
    } catch (err) {
      req.log.error(err);
      return reply.code(500).send({ error: "Failed to fetch deleted patients" });
    }
  });

  // ── GET /cashmemo/expense-summary ─────────────────────────────────────────
  // Total lab operational expense (staffSalary/medicine/testKit/products/others)
  // for a date range — sourced from the `expenses` collection, active only.
  // Applies to both lab types (operational expense isn't gated by IPD).
  fastify.get("/cashmemo/expense-summary", expenseSummaryQuerySchema, async (req, reply) => {
    try {
      const range = parseDateRange(req, reply);
      if (!range) return;
      const { startDate, endDate } = range;

      const [result] = await expenseCol()
        .aggregate(
          [
            {
              $match: {
                labId: labId(req),
                "deletion.status": false,
                createdAt: { $gte: startDate, $lte: endDate },
              },
            },
            {
              $group: {
                _id: null,
                totalExpense: { $sum: "$amount" },
                expenseCount: { $sum: 1 },
              },
            },
            { $project: { _id: 0, totalExpense: 1, expenseCount: 1 } },
          ],
          { allowDiskUse: true },
        )
        .toArray();

      return reply.send({
        totalExpense: Math.round(result?.totalExpense ?? 0),
        expenseCount: result?.expenseCount ?? 0,
      });
    } catch (err) {
      req.log.error(err);
      return reply.code(500).send({ error: "Failed to fetch expense summary" });
    }
  });
}

export default cashmemoRoutes;
