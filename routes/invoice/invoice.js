import toObjectId from "../../utils/db.js";
import generateInvoiceId from "../../utils/generateInvoiceId.js";

/**
 * ── Invoice document structure (as stored in "invoices" collection) ─────────
 *
 * {
 *   _id: ObjectId,
 *   labId: ObjectId,
 *   labKey: string,                      // e.g. "1111"
 *   invoiceId: string,                   // e.g. "ABC1234" (3 letters excl. O + 4 non-zero digits)
 *   createdAt: number,                   // epoch ms
 *   expiresAt: Date,                     // createdAt + 180 days (TTL-style field)
 *
 *   patient: {
 *     name: string,
 *     gender: "male" | "female" | "other",
 *     age: number,
 *     contactNumber: string,              // optional — may be an empty string
 *   },
 *
 *   referrer: {
 *     id: ObjectId | null,
 *     name: string | null,               // plain name only — never has a degree appended,
 *                                         // even when type is "doctor" (see `doctor` below)
 *     type: string | null,               // e.g. "doctor", "agent", "institute"
 *   },
 *
 *   // Independent of `referrer` — the doctor associated with this invoice.
 *   // Always present (nulled out if none was selected), regardless of
 *   // whether the frontend's "use doctor as referrer" toggle was on.
 *   // When that toggle IS on, `referrer` above is populated from this same
 *   // doctor's id/name (with type: "doctor") — but degree still only lives
 *   // here, never merged into referrer.name.
 *   // If the doctor was typed in but not selected from the registered list
 *   // (unregistered/unmatched doctor), only `name` is populated — id and
 *   // degree stay null.
 *   doctor: {
 *     id: ObjectId | null,
 *     name: string | null,
 *     degree: string | null,
 *   },
 *
 *   tests: [{
 *     testId: ObjectId,
 *     name: string,
 *     price: number,
 *     schemaId: ObjectId | null,          // presence marks this as an "online" test
 *     commission: number,                // per-test commission (e.g. to performing doctor/staff), snapshotted at invoice time
 *     // present only when schemaId is set:
 *     report?: object,
 *     isCompleted?: boolean,
 *   }],
 *
 *   products: [{
 *     productId: ObjectId,
 *     name: string,
 *     price: number,
 *     quantity: number,
 *     type: "product" | "service" | "medicine",
 *   }],
 *
 *   amount: {
 *     initial: number,                   // tests + products subtotal
 *     referrerDiscount: number,
 *     referrerCommission: number,
 *     referrerCommissionTestWise: number, // sum of tests[].commission — distinct from referrerCommission
 *     labAdjustment: number,
 *     invoiceFee: number,                // lab.billing.feePerInvoice, if applied — added to the patient's total
 *     final: number,                     // initial - referrerDiscount - labAdjustment + invoiceFee
 *     net: number,                       // final - referrerCommission
 *     paid: number,
 *   },
 *
 *   paymentMode: "cash" | "bkash" | "nagad" | "card" | "bank_transfer" | "others",
 *   isOnlineFeePaid: boolean,            // whether the lab's invoiceFee was applied to this invoice (only ever true if the invoice has an online test)
 *   onlineFeePaidBy: "lab" | "patient",  // which backend processed the fee — THIS route only accepts "lab"; "patient" is a separate backend
 *
 *   createdBy: { id: ObjectId, name: string },
 *
 *   delivery: {
 *     status: boolean,
 *     by: { id: ObjectId, name: string },
 *   },
 *
 *   collections: [{                      // payment history (initial payment + later due collections)
 *     by: { id: ObjectId, name: string },
 *     amount: number,
 *     mode: string,                      // one of PAYMENT_MODES
 *     at: number,                        // epoch ms
 *   }],
 *
 *   deletion: {
 *     status: boolean,
 *     at: number | null,
 *     by: { id: ObjectId, name: string } | { id: null, name: null },
 *   },
 *
 *   // set only by PATCH /invoice/:invoiceId/patient-info:
 *   updated?: {
 *     at: number,
 *     by: { id: ObjectId, name: string },
 *   },
 * }
 * ──────────────────────────────────────────────────────────────────────────
 */

// ─── Helpers ──────────────────────────────────────────────────────────────────
const getNestedField = (obj, path) => path.split(".").reduce((o, k) => o?.[k], obj);

const round2 = (n) => Math.round(n * 100) / 100;

const buildCursorFilter = ({ cursor, startDate, endDate, field = "createdAt" }) => {
  const range = {};
  if (startDate) range.$gte = startDate;
  if (endDate) range.$lte = endDate;
  if (cursor) range.$lt = endDate ? Math.min(cursor, endDate) : cursor;
  return Object.keys(range).length ? { [field]: range } : {};
};

const parsePaginationQuery = (query) => ({
  limit: Math.min(parseInt(query.limit) || 20, 100),
  cursor: query.cursor ? parseInt(query.cursor) : null,
  startDate: query.startDate ? parseInt(query.startDate) : null,
  endDate: query.endDate ? parseInt(query.endDate) : null,
});

const paginatedResponse = (result, limit, cursorField) => {
  const hasMore = result.length > limit;
  if (hasMore) result.pop();
  return {
    invoices: result,
    nextCursor: hasMore ? getNestedField(result.at(-1), cursorField) : null,
    hasMore,
  };
};

// ─── Reusable Schema Definitions ─────────────────────────────────────────────

const PRODUCT_TYPES = ["product", "service", "medicine"];

// Payment modes available for collecting money against an invoice
// (initial creation and later due-collection alike).
const PAYMENT_MODES = ["cash", "bkash", "nagad", "card", "bank_transfer", "others"];

const patientBodySchema = {
  type: "object",
  required: ["name", "gender", "age"],
  additionalProperties: false,
  description: "Patient details",
  properties: {
    name: { type: "string", minLength: 1, maxLength: 100, description: "Full name of the patient" },
    gender: { type: "string", enum: ["male", "female", "other"], description: "Gender of the patient" },
    age: { type: "integer", minimum: 0, maximum: 150, description: "Age of the patient in years" },
    contactNumber: {
      type: "string",
      minLength: 0,
      maxLength: 15,
      default: "",
      description: "Contact number of the patient (optional)",
    },
  },
};

const invoiceIdParamSchema = {
  type: "object",
  required: ["invoiceId"],
  properties: {
    invoiceId: {
      type: "string",
      pattern: "^[A-NP-Z]{3}[1-9]{4}$",
      minLength: 7,
      maxLength: 7,
      description: "Unique invoice ID (3 uppercase letters excluding O + 4 non-zero digits)",
    },
  },
};

const paginationQuerySchema = {
  type: "object",
  properties: {
    limit: { type: "integer", minimum: 1, maximum: 100, description: "Number of results per page (max 100)" },
    cursor: { type: "integer", minimum: 0, description: "Timestamp cursor for pagination" },
    startDate: { type: "integer", minimum: 0, description: "Filter start date as Unix timestamp (ms)" },
    endDate: { type: "integer", minimum: 0, description: "Filter end date as Unix timestamp (ms)" },
  },
};

// ─── Route Schemas ────────────────────────────────────────────────────────────

const requiredDataSchema = {
  schema: {
    tags: ["Invoices"],
    summary: "Fetch referrers, tests and products needed to create an invoice",
  },
};

// Separate from required-data on purpose — the "Doctor" field on the invoice
// form is independent of the referrers list (a referrer of type "doctor" is
// a different record from a registered doctor in the doctors collection).
// Includes commissionType/commissionValue so the frontend can drive the
// referrer-discount math off the selected doctor when "use doctor as
// referrer" is toggled on.
const getInvoiceDoctorsSchema = {
  schema: {
    tags: ["Invoices"],
    summary: "Fetch doctors for the Doctor field on invoice creation",
  },
};

const addInvoiceSchema = {
  schema: {
    tags: ["Invoices"],
    summary: "Create a new invoice",
    body: {
      type: "object",
      required: ["patient", "amount"],
      additionalProperties: false,
      properties: {
        patient: patientBodySchema,
        referrer: {
          type: "object",
          additionalProperties: false,
          description: "Referring doctor or entity (optional). name is always plain — never a degree-suffixed string.",
          properties: {
            id: { type: ["string", "null"], minLength: 24, maxLength: 24, description: "ObjectId of the referrer" },
            name: { type: ["string", "null"], maxLength: 150, description: "Name of the referrer" },
            type: { type: ["string", "null"], maxLength: 50, description: "Type of referrer e.g. doctor, clinic" },
          },
        },
        doctor: {
          type: "object",
          additionalProperties: false,
          description:
            "Doctor associated with this invoice, independent of the referrer (optional). Present even when the same doctor was also used as the referrer. When the doctor wasn't picked from the registered list, only name is populated — id and degree are null.",
          properties: {
            id: { type: ["string", "null"], minLength: 24, maxLength: 24, description: "ObjectId of the doctor" },
            name: { type: ["string", "null"], maxLength: 150, description: "Name of the doctor" },
            degree: { type: ["string", "null"], maxLength: 200, description: "Degree of the doctor" },
          },
        },
        tests: {
          type: "array",
          minItems: 0,
          maxItems: 50,
          default: [],
          description: "List of tests included in the invoice",
          items: {
            type: "object",
            required: ["testId", "name", "price"],
            additionalProperties: false,
            properties: {
              testId: { type: "string", minLength: 24, maxLength: 24, description: "ObjectId of the test" },
              name: { type: "string", minLength: 1, maxLength: 100, description: "Name of the test" },
              price: { type: "number", minimum: 0, maximum: 10000000, description: "Price of the test" },
              schemaId: {
                type: ["string", "null"],
                minLength: 24,
                maxLength: 24,
                description: "ObjectId of the report schema (if any) — presence marks this as an 'online' test",
              },
              commission: {
                type: "number",
                minimum: 0,
                maximum: 10000000,
                default: 0,
                description:
                  "Per-test commission (e.g. paid to the performing doctor/staff), snapshotted at invoice creation time",
              },
            },
          },
        },
        products: {
          type: "array",
          minItems: 0,
          maxItems: 100,
          default: [],
          description: "List of products, services, or medicines used in this invoice",
          items: {
            type: "object",
            required: ["productId", "name", "price", "quantity", "type"],
            additionalProperties: false,
            properties: {
              productId: { type: "string", minLength: 24, maxLength: 24, description: "ObjectId of the product" },
              name: { type: "string", minLength: 1, maxLength: 100, description: "Name of the product" },
              price: { type: "number", minimum: 0, maximum: 10000000, description: "Unit price of the product" },
              quantity: { type: "integer", minimum: 1, maximum: 10000, description: "Quantity used" },
              type: {
                type: "string",
                enum: PRODUCT_TYPES,
                description: "Category of the line item: product, service, or medicine",
              },
            },
          },
        },
        amount: {
          type: "object",
          required: ["initial", "referrerDiscount", "referrerCommission", "labAdjustment", "final", "net", "paid"],
          additionalProperties: false,
          description: "Invoice amount breakdown",
          properties: {
            initial: { type: "number", minimum: 0, maximum: 10000000 },
            referrerDiscount: { type: "number", minimum: 0, maximum: 10000000 },
            referrerCommission: { type: "number", minimum: 0, maximum: 10000000 },
            labAdjustment: { type: "number", minimum: 0, maximum: 10000000 },
            final: { type: "number", minimum: 0, maximum: 10000000 },
            net: { type: "number", minimum: 0, maximum: 10000000 },
            paid: { type: "number", minimum: 0, maximum: 10000000 },
            invoiceFee: {
              type: "number",
              minimum: 0,
              maximum: 10000000,
              default: 0,
              description: "Online invoice fee applied to this invoice, if any — added to the patient's total",
            },
          },
        },
        paymentMode: {
          type: "string",
          enum: PAYMENT_MODES,
          default: "cash",
          description:
            "Mode used for the amount paid at invoice creation (cash, bkash, nagad, card, bank_transfer, others)",
        },
        isOnlineFeePaid: {
          type: "boolean",
          default: false,
          description: "Whether the lab's online invoice fee was applied and paid on this invoice",
        },
        onlineFeePaidBy: {
          type: "string",
          enum: ["lab", "patient"],
          default: "lab",
          description:
            "Which backend processed the fee payment. This route only supports 'lab' — 'patient' is handled by a separate backend/service and is rejected here.",
        },
      },
    },
  },
};

const searchInvoiceSchema = {
  schema: {
    tags: ["Invoices"],
    summary: "Search invoices by phone, invoiceId, or patient name",
    querystring: {
      type: "object",
      required: ["q"],
      properties: {
        q: { type: "string", minLength: 1, maxLength: 100 },
      },
    },
  },
};

const collectDueSchema = {
  schema: {
    tags: ["Invoices"],
    summary: "Collect a payment (partial or full) against the due amount on an invoice",
    params: invoiceIdParamSchema,
    body: {
      type: "object",
      additionalProperties: false,
      properties: {
        // Optional — omitting it (or the whole body) collects the full due amount,
        // preserving the old behaviour. When provided, it is still re-validated
        // and clamped server-side against the invoice's actual due amount.
        amount: {
          type: "number",
          exclusiveMinimum: 0,
          maximum: 10000000,
          description: "Amount to collect now. Must be > 0 and <= the invoice's current due amount.",
        },
        paymentMode: {
          type: "string",
          enum: PAYMENT_MODES,
          default: "cash",
          description: "Mode used for this due collection",
        },
      },
    },
  },
};

const listInvoicesSchema = {
  schema: {
    tags: ["Invoices"],
    summary: "Get paginated list of active invoices",
    querystring: paginationQuerySchema,
  },
};

const deletedInvoicesSchema = {
  schema: {
    tags: ["Invoices"],
    summary: "Get paginated list of deleted invoices",
    querystring: paginationQuerySchema,
  },
};

const getInvoiceSchema = {
  schema: {
    tags: ["Invoices"],
    summary: "Get invoice by ID for the print/share view",
    params: invoiceIdParamSchema,
  },
};

const patientInfoSchema = {
  schema: {
    tags: ["Invoices"],
    summary: "Update patient info on an invoice",
    params: invoiceIdParamSchema,
    body: {
      type: "object",
      required: ["patient"],
      additionalProperties: false,
      properties: {
        patient: patientBodySchema,
      },
    },
  },
};

const markDeliveredSchema = {
  schema: {
    tags: ["Invoices"],
    summary: "Mark an invoice as delivered",
    params: invoiceIdParamSchema,
  },
};

const deleteInvoiceSchema = {
  schema: {
    tags: ["Invoices"],
    summary: "Soft delete an invoice",
    params: invoiceIdParamSchema,
  },
};

// ─── Routes ───────────────────────────────────────────────────────────────────

async function invoiceRoutes(fastify) {
  const col = () => fastify.mongo.db.collection("invoices");
  const labId = (req) => toObjectId(req.user.labId);
  const userId = (req) => toObjectId(req.user.id);

  fastify.addHook("onRequest", fastify.authenticate);

  const requireCreate = { onRequest: [fastify.authorize("createInvoice")] };
  const requireDelete = { onRequest: [fastify.authorize("deleteInvoice")] };
  const requireInvoiceList = { onRequest: [fastify.authorize("invoiceList")] };

  // ── GET /invoice/required-data ──────────────────────────────────────────────
  fastify.get("/invoice/required-data", { ...requiredDataSchema, ...requireCreate }, async (req, reply) => {
    try {
      const [referrers, tests, products] = await Promise.all([
        fastify.mongo.db
          .collection("referrers")
          .find(
            { labId: labId(req) },
            { projection: { name: 1, degree: 1, commissionType: 1, commissionValue: 1, type: 1 } },
          )
          .sort({ name: 1 })
          .toArray(),
        fastify.mongo.db
          .collection("tests")
          .find(
            { labId: labId(req) },
            { projection: { _id: 0, name: 1, price: 1, testId: 1, schemaId: 1, commission: 1 } },
          )
          .sort({ createdAt: -1 })
          .toArray(),
        fastify.mongo.db
          .collection("products")
          .find({ labId: labId(req) }, { projection: { name: 1, type: 1, price: 1, hasStock: 1, stock: 1 } })
          .sort({ name: 1 })
          .toArray(),
      ]);

      return reply.send({ referrers, tests, products });
    } catch (err) {
      req.log.error(err);
      return reply.code(500).send({ error: "Failed to fetch required data" });
    }
  });

  // ── GET /invoice/doctors ──────────────────────────────────────────────────
  // Powers the "Doctor" field on the invoice form — distinct from the
  // referrers list above. Same "createInvoice" gate, not "manageDoctors",
  // since any staff creating an invoice needs to be able to search doctors
  // here regardless of whether they can manage the doctors roster itself.
  fastify.get("/invoice/doctors", { ...getInvoiceDoctorsSchema, ...requireCreate }, async (req, reply) => {
    try {
      const doctors = await fastify.mongo.db
        .collection("doctors")
        .find({ labId: labId(req) }, { projection: { name: 1, degree: 1, commissionType: 1, commissionValue: 1 } })
        .sort({ name: 1 })
        .toArray();

      return reply.send({ doctors });
    } catch (err) {
      req.log.error(err);
      return reply.code(500).send({ error: "Failed to fetch doctors" });
    }
  });

  // ── POST /invoice/add ─────────────────────────────────────────────────────
  fastify.post("/invoice/add", { ...addInvoiceSchema, ...requireCreate }, async (req, reply) => {
    try {
      const {
        patient,
        referrer,
        doctor,
        tests,
        products = [],
        amount,
        paymentMode = "cash",
        isOnlineFeePaid = false,
        onlineFeePaidBy = "lab",
      } = req.body;

      if (amount.paid > amount.final) {
        return reply.code(400).send({ error: "Paid amount cannot exceed final amount" });
      }

      // ── At least one test or product required ───────────────────────────
      if (!tests.length && !products.length) {
        return reply.code(400).send({ error: "At least one test or product is required" });
      }

      // ── This backend only handles the "lab" fee-payment path ────────────
      // Patient-paid online fees go through a separate backend/service.
      if (onlineFeePaidBy !== "lab") {
        return reply.code(400).send({
          error: "This endpoint only supports the lab fee-payment backend. Patient-paid fees use a different service.",
        });
      }

      // ── Billing guard ───────────────────────────────────────────────────
      const isBlocked = await fastify.checkBillingBlocked(labId(req));
      if (isBlocked) {
        return reply.code(402).send({
          error:
            "Your account has an overdue bill. Please clear your outstanding balance to continue creating invoices.",
        });
      }

      // ── Validate the online invoice fee against the lab's own config ────
      // Billing config comes from the JWT (embedded at /login, carried
      // through /refresh) instead of a live DB lookup — see authRoutes.js.
      // It only goes stale between a billing change and the staff's next
      // /login or refresh cycle; the billing-update route clears sessions
      // for the lab to force that re-sync promptly.
      //
      // Mirrors the frontend's computeAmount(): the fee applies whenever the
      // lab forces it (and has a fee configured), or the client explicitly
      // marked isOnlineFeePaid. No dependency on what's in the cart.
      const configuredFee = req.user.billing?.feePerInvoice || 0;
      const feeForced = !!req.user.billing?.forceInvoiceFee;
      const expectedFeeApplied = feeForced ? configuredFee > 0 : isOnlineFeePaid;
      const expectedFee = expectedFeeApplied ? configuredFee : 0;

      if (Math.round((amount.invoiceFee || 0) * 100) !== Math.round(expectedFee * 100)) {
        return reply.code(400).send({ error: "Invoice fee does not match the lab's configured fee" });
      }

      // The fee is added on top of the patient's total when applied.
      // `final` must equal initial - referrerDiscount - labAdjustment + fee.
      const expectedFinal = Math.max(
        0,
        round2(amount.initial - amount.referrerDiscount - amount.labAdjustment + expectedFee),
      );

      if (Math.round(amount.final * 100) !== Math.round(expectedFinal * 100)) {
        return reply.code(400).send({ error: "Total amount does not match expected calculation" });
      }

      // ── Validate stock upfront ──────────────────────────────────────────
      if (products.length > 0) {
        const productCol = fastify.mongo.db.collection("products");
        const productIds = products.map((p) => toObjectId(p.productId));

        const dbProducts = await productCol
          .find(
            { _id: { $in: productIds }, labId: labId(req), hasStock: true },
            { projection: { _id: 1, name: 1, stock: 1 } },
          )
          .toArray();

        const stockMap = new Map(dbProducts.map((p) => [p._id.toString(), p]));

        for (const p of products) {
          const dbProduct = stockMap.get(p.productId);
          if (!dbProduct) continue; // hasStock: false — skip
          if (dbProduct.stock < p.quantity) {
            return reply.code(400).send({
              error: `Insufficient stock for "${dbProduct.name}". Available: ${dbProduct.stock}, requested: ${p.quantity}.`,
            });
          }
        }
      }

      // ── Generate unique invoice ID ──────────────────────────────────────
      let invoiceId;
      for (let i = 0; i < 5; i++) {
        const candidate = generateInvoiceId();
        if (!(await col().findOne({ invoiceId: candidate }, { projection: { _id: 1 } }))) {
          invoiceId = candidate;
          break;
        }
        await new Promise((r) => setTimeout(r, 10));
      }
      if (!invoiceId) {
        return reply.code(500).send({ error: "Failed to generate a unique invoice ID, please try again" });
      }

      // Single timestamp reused for createdAt, expiresAt, and each online
      // test's default sampleCollectionDate, so they all agree.
      const createdAt = Date.now();

      // Sum of each test's own `commission` field — distinct from
      // amount.referrerCommission (the referring doctor/agent's cut).
      // Derived server-side from the validated tests array, never trusted
      // from the client.
      const referrerCommissionTestWise = round2(tests.reduce((sum, t) => sum + (t.commission || 0), 0));

      // ── Insert invoice ──────────────────────────────────────────────────
      const invoiceCreationResult = await col().insertOne({
        labId: labId(req),
        labKey: String(req.user.labKey),
        invoiceId,
        createdAt,
        expiresAt: new Date(createdAt + 60 * 60 * 24 * 180 * 1000),
        patient: {
          name: patient.name,
          gender: patient.gender,
          age: patient.age,
          // Optional — stored as an empty string when the staff didn't
          // collect a contact number for this patient.
          contactNumber: patient.contactNumber ?? "",
        },
        referrer: referrer
          ? {
              id: referrer.id ? toObjectId(referrer.id) : null,
              name: referrer.name ?? null,
              type: referrer.type ?? null,
            }
          : { id: null, name: null, type: null },
        doctor: doctor
          ? {
              id: doctor.id ? toObjectId(doctor.id) : null,
              name: doctor.name ?? null,
              degree: doctor.degree ?? null,
            }
          : { id: null, name: null, degree: null },
        tests: tests.map((t) => ({
          testId: toObjectId(t.testId),
          name: t.name,
          price: t.price,
          schemaId: t.schemaId ? toObjectId(t.schemaId) : null,
          commission: t.commission || 0,
          // Online tests (schemaId set) start with an empty report shell:
          // sampleCollectionDate defaults to the invoice's creation time,
          // reportDate is unset until the report is actually filed.
          ...(t.schemaId && {
            report: {
              sampleCollectionDate: createdAt,
              reportDate: null,
            },
            isCompleted: false,
          }),
        })),
        products: products.map((p) => ({
          productId: toObjectId(p.productId),
          name: p.name,
          price: p.price,
          quantity: p.quantity,
          type: p.type,
        })),
        amount: {
          initial: amount.initial,
          referrerDiscount: amount.referrerDiscount,
          referrerCommission: amount.referrerCommission,
          referrerCommissionTestWise,
          labAdjustment: amount.labAdjustment,
          final: amount.final,
          net: amount.net,
          paid: amount.paid,
          invoiceFee: amount.invoiceFee || 0,
        },
        paymentMode,
        isOnlineFeePaid: expectedFeeApplied,
        onlineFeePaidBy,
        createdBy: {
          id: userId(req),
          name: req.user.name,
        },
        delivery: {
          status: false,
          by: { id: userId(req), name: req.user.name },
        },
        collections:
          amount.paid > 0
            ? [{ by: { id: userId(req), name: req.user.name }, amount: amount.paid, mode: paymentMode, at: createdAt }]
            : [],
        deletion: {
          status: false,
          at: null,
          by: { id: null, name: null },
        },
      });

      // ── Decrement stock for tracked products ────────────────────────────
      if (products.length > 0) {
        const productCol = fastify.mongo.db.collection("products");
        await Promise.all(
          products.map((p) =>
            productCol.updateOne(
              {
                _id: toObjectId(p.productId),
                labId: labId(req),
                hasStock: true,
                stock: { $gte: p.quantity },
              },
              {
                $inc: { stock: -p.quantity },
                $set: { updatedAt: createdAt },
              },
            ),
          ),
        );
      }

      return reply.code(201).send({
        invoiceId,
        link: `https://scan.labpilotpro.com/${req.user.labId}/${invoiceCreationResult.insertedId}/`,
      });
    } catch (err) {
      req.log.error(err);
      return reply.code(500).send({ error: "Failed to create invoice" });
    }
  });

  // ── GET /invoice/search ────────────────────────────────────────────────────
  // Intentionally unguarded — see header cleanup notes: patient-lookup flows
  // that aren't gated by "invoiceList" on the frontend depend on this route.
  fastify.get("/invoice/search", searchInvoiceSchema, async (req, reply) => {
    try {
      const q = req.query.q.trim();
      const isPhone = /^\d{7,15}$/.test(q);
      const isInvoiceId = /^[A-NP-Z]{3}[1-9]{4}$/i.test(q);

      const baseMatch = { labId: labId(req), "deletion.status": false };

      let filter;
      if (isPhone) {
        filter = { ...baseMatch, "patient.contactNumber": q };
      } else if (isInvoiceId) {
        filter = { ...baseMatch, invoiceId: q.toUpperCase() };
      } else {
        filter = { ...baseMatch, "patient.name": { $regex: q, $options: "i" } };
      }

      const results = await col()
        .find(filter, {
          projection: {
            _id: 1,
            invoiceId: 1,
            createdAt: 1,
            "createdBy.name": 1,
            "delivery.status": 1,
            "patient.name": 1,
            "patient.gender": 1,
            "patient.age": 1,
            "patient.contactNumber": 1,
            "amount.final": 1,
            "amount.paid": 1,
            "tests.schemaId": 1,
            paymentMode: 1,
          },
        })
        .sort({ createdAt: -1 })
        .limit(30)
        .toArray();

      return reply.send({ results, type: isPhone ? "phone" : isInvoiceId ? "invoiceId" : "name" });
    } catch (err) {
      req.log.error(err);
      return reply.code(500).send({ error: "Search failed" });
    }
  });

  // ── PATCH /invoice/:invoiceId/collect-due ─────────────────────────────────
  // Collects a payment against the outstanding due amount. The amount is
  // optional — omit it to collect the full due (old behaviour) — but whatever
  // is sent is always re-derived and clamped server-side against the
  // invoice's *current* due, never trusting the client's number as-is:
  //   - never negative (schema requires > 0; also floored at 0 defensively)
  //   - never more than the actual due amount at the moment of the update
  //
  // Intentionally unguarded — see header cleanup notes: no "collectPayment"
  // permission key exists yet (mirrors indoorPatients' /payment route).
  fastify.patch("/invoice/:invoiceId/collect-due", collectDueSchema, async (req, reply) => {
    try {
      const { invoiceId } = req.params;
      const paymentMode = req.body?.paymentMode || "cash";

      const invoice = await col().findOne(
        { invoiceId, labId: labId(req) },
        { projection: { "amount.final": 1, "amount.paid": 1 } },
      );
      if (!invoice) return reply.code(404).send({ error: "Invoice not found" });

      const due = Math.max(0, invoice.amount.final - invoice.amount.paid);
      if (due <= 0) return reply.code(400).send({ error: "Invoice already fully paid" });

      // Requested amount defaults to the full due; always clamped to (0, due].
      const requested = req.body?.amount != null ? Number(req.body.amount) : due;
      if (!Number.isFinite(requested) || requested <= 0) {
        return reply.code(400).send({ error: "Amount to collect must be a positive number" });
      }
      const collectAmount = Math.round(Math.min(requested, due) * 100) / 100;

      const newPaid = Math.min(invoice.amount.final, invoice.amount.paid + collectAmount);

      const result = await col().updateOne(
        { invoiceId, labId: labId(req) },
        {
          $set: { "amount.paid": newPaid },
          $push: {
            collections: {
              by: { id: userId(req), name: req.user.name },
              amount: collectAmount,
              mode: paymentMode,
              at: Date.now(),
            },
          },
        },
      );
      if (result.modifiedCount === 0) return reply.code(400).send({ error: "Nothing to update" });

      return reply.send({
        success: true,
        collected: collectAmount,
        paid: newPaid,
        due: Math.max(0, invoice.amount.final - newPaid),
        paymentMode,
      });
    } catch (err) {
      req.log.error(err);
      return reply.code(500).send({ error: "Failed to collect due amount" });
    }
  });

  // ── GET /invoice/all ───────────────────────────────────────────────────────
  fastify.get("/invoice/all", { ...listInvoicesSchema, ...requireInvoiceList }, async (req, reply) => {
    try {
      const { limit, cursor, startDate, endDate } = parsePaginationQuery(req.query);

      const result = await col()
        .find(
          {
            labId: labId(req),
            "deletion.status": false,
            ...buildCursorFilter({ cursor, startDate, endDate }),
          },
          {
            projection: {
              _id: 1,
              invoiceId: 1,
              createdAt: 1,
              "createdBy.name": 1,
              "delivery.status": 1,
              "patient.name": 1,
              "patient.gender": 1,
              "patient.age": 1,
              "patient.contactNumber": 1,
              "amount.final": 1,
              "amount.paid": 1,
              "tests.schemaId": 1,
              paymentMode: 1,
            },
          },
        )
        .sort({ createdAt: -1 })
        .limit(limit + 1)
        .toArray();

      return reply.send(paginatedResponse(result, limit, "createdAt"));
    } catch (err) {
      req.log.error(err);
      return reply.code(500).send({ error: "Failed to fetch invoices" });
    }
  });

  // ── GET /invoice/deleted ───────────────────────────────────────────────────
  fastify.get("/invoice/deleted", { ...deletedInvoicesSchema, ...requireDelete }, async (req, reply) => {
    try {
      const { limit, cursor, startDate, endDate } = parsePaginationQuery(req.query);
      const result = await col()
        .find(
          {
            labId: labId(req),
            "deletion.status": true,
            ...buildCursorFilter({ cursor, startDate, endDate, field: "deletion.at" }),
          },
          {
            projection: {
              _id: 1,
              invoiceId: 1,
              createdAt: 1,
              "deletion.by.name": 1,
              "deletion.at": 1,
              "patient.name": 1,
              "patient.gender": 1,
              "patient.age": 1,
              "patient.contactNumber": 1,
              "amount.final": 1,
              "amount.paid": 1,
              "tests.schemaId": 1,
              paymentMode: 1,
            },
          },
        )
        .sort({ "deletion.at": -1 })
        .limit(limit + 1)
        .toArray();
      return reply.send(paginatedResponse(result, limit, "deletion.at"));
    } catch (err) {
      req.log.error(err);
      return reply.code(500).send({ error: "Failed to fetch deleted invoices" });
    }
  });

  // ── GET /invoice/:invoiceId ────────────────────────────────────────────────
  // FIX: previously returned the full raw document (no projection) — leaked
  // internal fields (labId, labKey, deletion, test commissions, referrer id,
  // etc.) to whatever consumes this route (PrintInvoice.jsx's print/share
  // view, and InvoiceDetailsModal in InvoiceList.jsx). Project down to
  // exactly what those consumers read.
  //
  // FIX (this pass): the projection below was missing createdBy, delivery
  // (status + by.name), and collections entirely — so InvoiceDetailsModal's
  // "তৈরিকারী" (created-by), delivery-status, and collection-history
  // sections always rendered blank/false even though InvoiceRow/InvoiceCard
  // on the list page showed them fine (that list comes from a *different*
  // route, GET /invoice/all, whose projection already included them).
  // Added the three below so both surfaces agree.
  //
  // Intentionally unguarded — see header cleanup notes: powers the print/share
  // view, which isn't gated by "invoiceList" on the frontend.
  fastify.get("/invoice/:invoiceId", getInvoiceSchema, async (req, reply) => {
    try {
      const invoice = await col().findOne(
        { invoiceId: req.params.invoiceId, labId: labId(req) },
        {
          projection: {
            invoiceId: 1,
            createdAt: 1,
            "createdBy.name": 1,
            "delivery.status": 1,
            "delivery.by.name": 1,
            "patient.name": 1,
            "patient.gender": 1,
            "patient.age": 1,
            "patient.contactNumber": 1,
            "referrer.name": 1,
            "referrer.type": 1,
            "doctor.name": 1,
            "doctor.degree": 1,
            "tests.name": 1,
            "tests.price": 1,
            "products.name": 1,
            "products.price": 1,
            "products.quantity": 1,
            "amount.initial": 1,
            "amount.referrerDiscount": 1,
            "amount.referrerCommission": 1,
            "amount.labAdjustment": 1,
            "amount.final": 1,
            "amount.paid": 1,
            "amount.invoiceFee": 1,
            paymentMode: 1,
            collections: 1,
          },
        },
      );
      if (!invoice) return reply.code(404).send({ error: "Invoice not found" });

      // `link` isn't a stored field — it's derived from invoiceId the same
      // way POST /invoice/add returns it at creation time. Reconstruct it
      // here so PrintInvoice.jsx's normaliseInvoice() has reportLink/link
      // to fall back on when it fetches by ID directly (not via router state).
      return reply.send({ ...invoice, link: `https://scan.labpilotpro.com/${req.user.labId}/${invoice._id}/` });
    } catch (err) {
      req.log.error(err);
      return reply.code(500).send({ error: "Failed to fetch invoice" });
    }
  });

  // ── PATCH /invoice/:invoiceId/patient-info ────────────────────────────────
  // Intentionally unguarded — see header cleanup notes: no analogous unused
  // permission key exists to attach here (unlike indoorPatients' patient-info,
  // which could reuse an already-defined but unused "editPatient" key).
  fastify.patch("/invoice/:invoiceId/patient-info", patientInfoSchema, async (req, reply) => {
    try {
      const { invoiceId } = req.params;
      const { patient } = req.body;

      if (!(await col().findOne({ invoiceId, labId: labId(req) }, { projection: { _id: 1 } })))
        return reply.code(404).send({ error: "Invoice not found" });

      const update = {
        patient: {
          name: patient.name.trim(),
          gender: patient.gender,
          age: patient.age,
          contactNumber: (patient.contactNumber ?? "").trim(),
        },
        updated: {
          at: Date.now(),
          by: { id: userId(req), name: req.user.name },
        },
      };

      await col().updateOne({ invoiceId, labId: labId(req) }, { $set: update });
      return reply.send({ success: true, ...update });
    } catch (err) {
      req.log.error(err);
      return reply.code(500).send({ error: "Failed to update patient info" });
    }
  });

  // ── PATCH /invoice/:invoiceId/mark-delivered ──────────────────────────────
  // Intentionally unguarded — see header cleanup notes: no matching permission
  // key exists yet for delivery-status changes.
  fastify.patch("/invoice/:invoiceId/mark-delivered", markDeliveredSchema, async (req, reply) => {
    try {
      const { invoiceId } = req.params;

      const invoice = await col().findOne({ invoiceId, labId: labId(req) }, { projection: { "delivery.status": 1 } });
      if (!invoice) return reply.code(404).send({ error: "Invoice not found" });
      if (invoice.delivery.status) return reply.code(400).send({ error: "Invoice already marked as delivered" });

      await col().updateOne(
        { invoiceId, labId: labId(req) },
        {
          $set: {
            delivery: {
              status: true,
              by: { id: userId(req), name: req.user.name },
            },
          },
        },
      );
      return reply.send({ success: true });
    } catch (err) {
      req.log.error(err);
      return reply.code(500).send({ error: "Failed to mark invoice as delivered" });
    }
  });

  // ── PATCH /invoice/:invoiceId/delete ──────────────────────────────────────
  fastify.patch("/invoice/:invoiceId/delete", { ...deleteInvoiceSchema, ...requireDelete }, async (req, reply) => {
    try {
      const { invoiceId } = req.params;

      const invoice = await col().findOne({ invoiceId, labId: labId(req) }, { projection: { "deletion.status": 1 } });
      if (!invoice) return reply.code(404).send({ error: "Invoice not found" });
      if (invoice.deletion.status) return reply.code(400).send({ error: "Invoice already deleted" });

      await col().updateOne(
        { invoiceId, labId: labId(req) },
        {
          $set: {
            deletion: {
              status: true,
              at: Date.now(),
              by: { id: userId(req), name: req.user.name },
            },
          },
        },
      );
      return reply.send({ success: true });
    } catch (err) {
      req.log.error(err);
      return reply.code(500).send({ error: "Failed to delete invoice" });
    }
  });
}

export default invoiceRoutes;
