/**
 * indoorPatients.routes.js
 *
 * Cleanup notes (see audit):
 *  - patient-info / clinical-notes / transfer-ward / change-doctor previously had
 *    NO authorize() guard, unlike every other mutating route on this collection.
 *    Added authorize("editPatient") checks — this key already exists in
 *    ALLOWED_PERMISSIONS, so no schema/role-editor change is needed.
 *  - POST /indoor-patient/:id/payment is intentionally left WITHOUT a permission
 *    gate, unlike every other mutating route on this collection. No matching
 *    permission key exists (e.g. "collectPayment") — revisit once that's added
 *    to ALLOWED_PERMISSIONS and the role editor.
 *  - "bed-charge" discount category previously used `categoryTotal = Infinity`,
 *    meaning bed-charge discounts had NO upper bound. Fixed to compute the real
 *    accrued bed total (same day-walk logic used for grand-total), extracted
 *    into computeBedTotal() to avoid duplicating the loop.
 *  - GET /indoor-patients (list) intentionally left without a permission gate:
 *    SearchPatient.jsx and AddItemsToPatient.jsx both depend on it for patient
 *    lookup flows that aren't gated by the "patientList" permission on the
 *    frontend. Locking it down to "patientList" would break those flows unless
 *    all roles that can search/add-items also hold "patientList". Flagging this
 *    explicitly rather than guessing — revisit once the full permission matrix
 *    is available.
 *  - Retention: released patients are auto-purged 365 days after discharge via
 *    a MongoDB TTL index on `purgeAt` (a real BSON Date, unlike the rest of
 *    this schema's numeric timestamps — TTL indexes only fire on Date fields).
 *    `purgeAt` is set once, at release time. Admitted patients never get this
 *    field, so they're never touched by the TTL sweep. This is a PERMANENT,
 *    UNRECOVERABLE hard delete — see backfill script for pre-existing released
 *    patients, which won't have `purgeAt` until it's run once.
 *  - Patient age: switched from a single integer to a { years, months, days }
 *    object (mirrors the same shape used on invoices — see patientAgeSchema
 *    and normalizePatientAge below). Any part omitted from the request
 *    defaults to 0. Existing documents written before this change still hold
 *    a plain integer in patient.age — run a backfill to convert them to
 *    { years, months: 0, days: 0 } if old records need to match the new shape.
 */

import { randomUUID } from "crypto";
import toObjectId from "../../utils/db.js";

const COLLECTION = "indoorPatients";
const BLOOD_GROUPS = ["A+", "A-", "B+", "B-", "AB+", "AB-", "O+", "O-"];

// Mirrors invoiceRoutes.js PAYMENT_MODES
const PAYMENT_MODES = ["cash", "bkash", "nagad", "card", "bank_transfer", "others"];

// Retention window for released patients — see TTL index in onReady() below.
const ONE_YEAR_MS = 365 * 24 * 60 * 60 * 1000;

// ─── Schema Fragments ─────────────────────────────────────────────────────────

const OBJECT_ID_PATTERN = "^[a-fA-F0-9]{24}$";
const objectIdSchema = { type: "string", pattern: OBJECT_ID_PATTERN };
const nullableObjectIdSchema = { type: ["string", "null"], pattern: OBJECT_ID_PATTERN };

const guardianSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    name: { type: "string", maxLength: 100 },
    relation: { type: "string", maxLength: 50 },
    contactNumber: { type: "string", maxLength: 15 },
  },
};

// Mirrors the age shape used on invoices — years / months / days, any part
// may be omitted and defaults to 0 (see normalizePatientAge below, which is
// what actually applies that default when writing to the DB).
const patientAgeSchema = {
  type: "object",
  additionalProperties: false,
  description: "Patient age as years / months / days — any part may be omitted (defaults to 0)",
  properties: {
    years: { type: "integer", minimum: 0, maximum: 150, default: 0, description: "Whole years of age (0–150)" },
    months: { type: "integer", minimum: 0, maximum: 11, default: 0, description: "Additional months (0–11)" },
    days: { type: "integer", minimum: 0, maximum: 31, default: 0, description: "Additional days (0–31)" },
  },
};

const patientInfoSchema = {
  type: "object",
  required: ["name", "age", "gender", "contactNumber"],
  additionalProperties: false,
  properties: {
    name: { type: "string", minLength: 1, maxLength: 120 },
    age: patientAgeSchema,
    gender: { type: "string", enum: ["male", "female", "other"] },
    bloodGroup: { type: "string", enum: BLOOD_GROUPS },
    contactNumber: { type: "string", minLength: 10, maxLength: 15 },
    address: { type: "string", maxLength: 500 },
    guardian: guardianSchema,
  },
};

const diseaseSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    description: { type: "string", maxLength: 2000 },
    medicalHistory: { type: "string", maxLength: 3000 },
  },
};

const packageDealSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    description: { type: "string", maxLength: 500 },
    totalAmount: { type: "number", minimum: 0 },
  },
};

// ─── Route Schemas ────────────────────────────────────────────────────────────

const getRequiredDataSchema = {
  schema: { tags: ["IndoorPatients"], summary: "Get spaces, doctors and referrers needed for patient admission" },
};

const listPatientsSchema = {
  schema: {
    tags: ["IndoorPatients"],
    summary: "Get list of indoor patients with optional filters",
    querystring: {
      type: "object",
      additionalProperties: false,
      properties: {
        status: { type: "string", enum: ["admitted", "released", "all"] },
        search: { type: "string", maxLength: 100 },
        page: { type: "integer", minimum: 1, default: 1 },
        limit: { type: "integer", minimum: 1, maximum: 100, default: 20 },
      },
    },
  },
};

const getPatientSchema = {
  schema: {
    tags: ["IndoorPatients"],
    summary: "Get full indoor patient record by ID",
    params: {
      type: "object",
      required: ["id"],
      additionalProperties: false,
      properties: { id: objectIdSchema },
    },
  },
};

const admitPatientSchema = {
  schema: {
    tags: ["IndoorPatients"],
    summary: "Admit a new indoor patient",
    body: {
      type: "object",
      required: ["patient", "spaceId", "doctorId", "dealType"],
      additionalProperties: false,
      properties: {
        patient: patientInfoSchema,
        spaceId: objectIdSchema,
        bedNumber: { type: ["integer", "null"] },
        doctorId: objectIdSchema,
        referrerId: nullableObjectIdSchema,
        referrerName: { type: ["string", "null"], maxLength: 150 },
        referrerType: { type: ["string", "null"], maxLength: 50 },
        disease: diseaseSchema,
        dealType: { type: "string", enum: ["package", "regular"] },
        packageDeal: packageDealSchema,
      },
    },
  },
};

const updatePatientInfoSchema = {
  schema: {
    tags: ["IndoorPatients"],
    summary: "Update patient basic info",
    params: {
      type: "object",
      required: ["id"],
      additionalProperties: false,
      properties: { id: objectIdSchema },
    },
    body: {
      type: "object",
      required: ["patient"],
      additionalProperties: false,
      properties: { patient: patientInfoSchema },
    },
  },
};

const transferWardSchema = {
  schema: {
    tags: ["IndoorPatients"],
    summary: "Transfer patient to another ward/bed",
    params: {
      type: "object",
      required: ["id"],
      additionalProperties: false,
      properties: { id: objectIdSchema },
    },
    body: {
      type: "object",
      required: ["spaceId"],
      additionalProperties: false,
      properties: {
        spaceId: objectIdSchema,
        bedNumber: { type: ["integer", "null"] },
        note: { type: "string", maxLength: 500 },
      },
    },
  },
};

const changeDoctorSchema = {
  schema: {
    tags: ["IndoorPatients"],
    summary: "Change the supervisor doctor for a patient",
    params: {
      type: "object",
      required: ["id"],
      additionalProperties: false,
      properties: { id: objectIdSchema },
    },
    body: {
      type: "object",
      required: ["doctorId"],
      additionalProperties: false,
      properties: {
        doctorId: objectIdSchema,
        note: { type: "string", maxLength: 500 },
      },
    },
  },
};

const addExpenseSchema = {
  schema: {
    tags: ["IndoorPatients"],
    summary: "Add an expense item",
    params: {
      type: "object",
      required: ["id"],
      additionalProperties: false,
      properties: { id: objectIdSchema },
    },
    body: {
      type: "object",
      required: ["type", "name", "price", "quantity"],
      additionalProperties: false,
      properties: {
        type: { type: "string", enum: ["medicine", "product", "test", "service", "other"] },
        itemId: nullableObjectIdSchema,
        name: { type: "string", minLength: 1, maxLength: 200 },
        price: { type: "number", minimum: 0 },
        quantity: { type: "integer", minimum: 1, default: 1 },
        note: { type: "string", maxLength: 300 },
        schemaId: nullableObjectIdSchema,
        // Mirrors tests[].commission in invoiceRoutes.js — snapshotted at add-time,
        // only meaningful when type === "test".
        commission: { type: "number", minimum: 0, maximum: 10000000, default: 0 },
      },
    },
  },
};

const addDiscountSchema = {
  schema: {
    tags: ["IndoorPatients"],
    summary: "Add a discount to a specific expense category or grand total",
    params: {
      type: "object",
      required: ["id"],
      additionalProperties: false,
      properties: { id: objectIdSchema },
    },
    body: {
      type: "object",
      required: ["category", "amount", "providedBy"],
      additionalProperties: false,
      properties: {
        category: {
          type: "string",
          enum: ["test", "medicine", "bed-charge", "product", "other", "grand-total"],
        },
        amount: { type: "number", minimum: 0.01 },
        providedBy: { type: "string", enum: ["hospital", "doctor", "referrer"] },
        note: { type: "string", maxLength: 300 },
      },
    },
  },
};

const addPaymentSchema = {
  schema: {
    tags: ["IndoorPatients"],
    summary: "Record a payment collection",
    params: {
      type: "object",
      required: ["id"],
      additionalProperties: false,
      properties: { id: objectIdSchema },
    },
    body: {
      type: "object",
      required: ["amount"],
      additionalProperties: false,
      properties: {
        amount: { type: "number", minimum: 0.01 },
        note: { type: "string", maxLength: 300 },
        paymentMode: {
          type: "string",
          enum: PAYMENT_MODES,
          default: "cash",
          description: "Mode used for this payment collection",
        },
      },
    },
  },
};

const updatePaymentModeSchema = {
  schema: {
    tags: ["IndoorPatients"],
    summary: "Update the payment mode of a specific payment — only the staff member who collected it may edit it",
    params: {
      type: "object",
      required: ["id", "paymentId"],
      additionalProperties: false,
      properties: {
        id: objectIdSchema,
        paymentId: { type: "string", minLength: 1, maxLength: 100 },
      },
    },
    body: {
      type: "object",
      required: ["paymentMode"],
      additionalProperties: false,
      properties: { paymentMode: { type: "string", enum: PAYMENT_MODES } },
    },
  },
};

const releasePatientSchema = {
  schema: {
    tags: ["IndoorPatients"],
    summary: "Release / discharge an admitted patient",
    params: {
      type: "object",
      required: ["id"],
      additionalProperties: false,
      properties: { id: objectIdSchema },
    },
    body: {
      type: "object",
      additionalProperties: false,
      properties: { note: { type: "string", maxLength: 500 } },
    },
  },
};

const updateClinicalNotesSchema = {
  schema: {
    tags: ["IndoorPatients"],
    summary: "Update patient clinical notes (diagnosis/description and medical history)",
    params: {
      type: "object",
      required: ["id"],
      additionalProperties: false,
      properties: { id: objectIdSchema },
    },
    body: {
      type: "object",
      required: ["disease"],
      additionalProperties: false,
      properties: { disease: diseaseSchema },
    },
  },
};

const softDeletePatientSchema = {
  schema: {
    tags: ["IndoorPatients"],
    summary: "Soft delete an indoor patient record",
    params: {
      type: "object",
      required: ["id"],
      additionalProperties: false,
      properties: { id: objectIdSchema },
    },
    body: {
      type: "object",
      additionalProperties: false,
      properties: { note: { type: "string", maxLength: 500 } },
    },
  },
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

const now = () => Date.now();
const by = (req) => ({ id: toObjectId(req.user.id), name: req.user.name });

// Every read/write path on this collection must exclude soft-deleted records.
// Spreading this into a filter alongside `_id` keeps every route consistent
// and means a single change here updates every query at once.
const notDeletedFilter = (req) => ({ labId: toObjectId(req.user.labId), "deletion.at": null });

// Mirrors CreateInvoice.jsx's normalizeAge on the frontend: any part left out
// of the request body defaults to 0 rather than being stored as undefined.
const normalizePatientAge = (age) => ({
  years: Number.isInteger(age?.years) ? age.years : 0,
  months: Number.isInteger(age?.months) ? age.months : 0,
  days: Number.isInteger(age?.days) ? age.days : 0,
});

const generateAdmissionId = async (col, labId) => {
  const DIGIT_CHARS = "123456789";
  const LETTER_CHARS = "ABCDEFGHIJKLMNPQRSTUVWXYZ";
  const maxAttempts = 10;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    let candidate = "IP";
    for (let i = 0; i < 3; i++) candidate += DIGIT_CHARS[Math.floor(Math.random() * DIGIT_CHARS.length)];
    for (let i = 0; i < 2; i++) candidate += LETTER_CHARS[Math.floor(Math.random() * LETTER_CHARS.length)];

    const exists = await col.findOne({ labId, admissionId: candidate }, { projection: { _id: 1 } });
    if (!exists) return candidate;
  }

  throw new Error("Failed to generate unique admission ID after multiple attempts");
};

// Walks admittedAt..releasedAt (or now, if still admitted) day-by-day in BST,
// applying the correct chargePerDay for each day based on wardHistory.
// Shared by the grand-total and bed-charge branches of the discount route so
// the accrual logic only lives in one place.
const computeBedTotal = (admission) => {
  if (admission.dealType !== "regular") return 0;

  const tsBst = (ts) => new Date(ts + 6 * 3600 * 1000).toISOString().slice(0, 10);
  const startStr = tsBst(admission.admittedAt);
  const endStr = admission.releasedAt ? tsBst(admission.releasedAt) : tsBst(Date.now());
  const startD = new Date(startStr + "T00:00:00Z");
  const endD = new Date(endStr + "T00:00:00Z");

  let total = 0;
  const cur = new Date(startD);
  while (cur <= endD) {
    const d = cur.toISOString().slice(0, 10);
    let daily = admission.space.chargePerDay;
    for (const h of admission.wardHistory ?? []) {
      if (!h.fromDate || !h.toDate) continue;
      const from = tsBst(h.fromDate);
      const to = tsBst(h.toDate);
      if (d >= from && d < to) {
        daily = h.chargePerDay ?? admission.space.chargePerDay;
        break;
      }
    }
    total += daily;
    cur.setUTCDate(cur.getUTCDate() + 1);
  }
  return total;
};

// ─── Projection: full patient (GET /indoor-patient/:id) ───────────────────────
// Excludes waivers and bedCharges — both legacy fields never read by the frontend.
// reports kept: the /ipd/patient/:id/reports page fetches via getPatient().
const PATIENT_FULL_PROJECTION = {
  waivers: 0,
  bedCharges: 0,
};

// ─── Projection: list row (GET /indoor-patients) ──────────────────────────────
const PATIENT_LIST_PROJECTION = {
  admissionId: 1,
  status: 1,
  patient: 1,
  "space.spaceName": 1,
  "space.bedNumber": 1,
  "space.fromDate": 1,
  "supervisorDoctor.name": 1,
  expenses: 1, // needed for totalExpenses() in SearchPatient / AddItemsToPatient list
  payments: 1, // needed for totalPayments() / due calculation in list rows
  dealType: 1, // needed for package badge in list rows
  admittedAt: 1,
  releasedAt: 1,
};

// ─── Routes ───────────────────────────────────────────────────────────────────

async function indoorPatientRoutes(fastify) {
  const col = () => fastify.mongo.db.collection(COLLECTION);
  const spacesCol = () => fastify.mongo.db.collection("admissionSpaces");
  const doctorsCol = () => fastify.mongo.db.collection("doctors");
  const referrersCol = () => fastify.mongo.db.collection("referrers");
  const labId = (req) => toObjectId(req.user.labId);

  fastify.addHook("onRequest", fastify.authenticate);

  // IPD is a hospital-only module — diagnosticCenter labs must never reach these routes,
  // mirroring the isHospital guard pattern used in cashmemo/commissionReport/salesReport routes.
  fastify.addHook("onRequest", async (req, reply) => {
    if (req.user.type !== "hospital") {
      return reply.code(403).send({ error: "Indoor patient management is only available for hospital labs" });
    }
  });

  const requireAdmit = { onRequest: [fastify.authorize("admitPatient")] };
  const requireAddExpense = { onRequest: [fastify.authorize("addExpenseToPatient")] };
  const requireDelete = { onRequest: [fastify.authorize("deletePatient")] };
  const requireRelease = { onRequest: [fastify.authorize("releasePatient")] };
  const requireDiscount = { onRequest: [fastify.authorize("discount")] };
  const requireEdit = { onRequest: [fastify.authorize("editPatient")] };
  const requireList = { onRequest: [fastify.authorize("patientList")] };

  // Ensures the TTL index exists on boot. Safe to run every startup — createIndex
  // is idempotent. purgeAt is a real BSON Date (set only at release time, see the
  // /release handler below); expireAfterSeconds: 0 means "expire exactly at the
  // stored date" rather than N seconds after it. Admitted patients never get a
  // purgeAt field, so the TTL monitor never considers them.
  fastify.addHook("onReady", async () => {
    try {
      await col().createIndex({ purgeAt: 1 }, { expireAfterSeconds: 0, name: "purgeAt_ttl" });
    } catch (err) {
      fastify.log.error(err, "Failed to ensure indoorPatients purgeAt TTL index");
    }
  });

  // ── GET /indoor-patients/required-data ──────────────────────────────────────
  fastify.get("/indoor-patients/required-data", getRequiredDataSchema, async (req, reply) => {
    try {
      const [spaces, doctors, referrers] = await Promise.all([
        spacesCol()
          .find({ labId: labId(req) })
          .sort({ name: 1 })
          .toArray(),
        doctorsCol()
          .find({ labId: labId(req) })
          .sort({ name: 1 })
          .toArray(),
        referrersCol()
          .find({ labId: labId(req), isActive: true })
          .sort({ name: 1 })
          .toArray(),
      ]);
      return reply.send({ spaces, doctors, referrers });
    } catch (err) {
      req.log.error(err);
      return reply.code(500).send({ error: "Failed to fetch required data" });
    }
  });

  // ── GET /indoor-patients ─────────────────────────────────────────────────────
  fastify.get("/indoor-patients", { ...listPatientsSchema, ...requireList }, async (req, reply) => {
    try {
      const { status = "admitted", search = "", page = 1, limit = 20 } = req.query;
      const skip = (page - 1) * limit;

      const filter = { ...notDeletedFilter(req) };
      if (status !== "all") filter.status = status;
      if (search.trim()) {
        filter.$or = [
          { "patient.name": { $regex: search.trim(), $options: "i" } },
          { "patient.contactNumber": { $regex: search.trim(), $options: "i" } },
          { admissionId: { $regex: search.trim(), $options: "i" } },
        ];
      }

      const [patients, total] = await Promise.all([
        col()
          .find(filter, { projection: PATIENT_LIST_PROJECTION })
          .sort({ admittedAt: -1 })
          .skip(skip)
          .limit(limit)
          .toArray(),
        col().countDocuments(filter),
      ]);

      return reply.send({ patients, total, page, totalPages: Math.ceil(total / limit) });
    } catch (err) {
      req.log.error(err);
      return reply.code(500).send({ error: "Failed to fetch indoor patients" });
    }
  });

  // ── GET /indoor-patient/:id ──────────────────────────────────────────────────
  fastify.get("/indoor-patient/:id", getPatientSchema, async (req, reply) => {
    try {
      const _id = toObjectId(req.params.id);
      if (!_id) return reply.code(400).send({ error: "Invalid patient ID" });
      const patient = await col().findOne({ _id, ...notDeletedFilter(req) }, { projection: PATIENT_FULL_PROJECTION });
      if (!patient) return reply.code(404).send({ error: "Indoor patient not found" });
      return reply.send(patient);
    } catch (err) {
      req.log.error(err);
      return reply.code(500).send({ error: "Failed to fetch indoor patient" });
    }
  });

  // ── POST /indoor-patient/admit ───────────────────────────────────────────────
  fastify.post("/indoor-patient/admit", { ...admitPatientSchema, ...requireAdmit }, async (req, reply) => {
    try {
      const {
        patient,
        spaceId,
        bedNumber,
        doctorId,
        referrerId,
        referrerName,
        referrerType,
        disease,
        dealType,
        packageDeal,
      } = req.body;

      const space = await spacesCol().findOne({ _id: toObjectId(spaceId), labId: labId(req) });
      if (!space) return reply.code(404).send({ error: "Space not found" });

      if (space.multiBed) {
        if (bedNumber == null) return reply.code(400).send({ error: "bedNumber is required for multi-bed spaces" });
        const { totalNumberOfBed, bedStartingNumber, booked = [], reserved = [] } = space.multiBedConf;
        if (bedNumber < bedStartingNumber || bedNumber >= bedStartingNumber + totalNumberOfBed)
          return reply.code(400).send({ error: "Bed number out of range" });
        if (booked.includes(bedNumber)) return reply.code(409).send({ error: "Bed is already occupied" });
        if (reserved.some((r) => r.bedNumber === bedNumber))
          return reply.code(409).send({ error: "Bed is already reserved" });
      } else {
        if (space.reserved) return reply.code(409).send({ error: "Space is already reserved" });
      }

      const doctor = await doctorsCol().findOne({ _id: toObjectId(doctorId), labId: labId(req) });
      if (!doctor) return reply.code(404).send({ error: "Doctor not found" });

      let resolvedReferrer = { referrerId: null, name: referrerName ?? null, type: referrerType ?? null };
      if (referrerId) {
        const ref = await referrersCol().findOne({ _id: toObjectId(referrerId), labId: labId(req) });
        if (ref) resolvedReferrer = { referrerId: toObjectId(referrerId), name: ref.name, type: ref.type };
      }

      if (dealType === "package" && !packageDeal)
        return reply.code(400).send({ error: "packageDeal is required when dealType is package" });

      const admissionId = await generateAdmissionId(col(), labId(req));
      const admittedAt = now();

      const doc = {
        labId: labId(req),
        labKey: String(req.user.labKey),
        admissionId,
        status: "admitted",
        patient: {
          name: patient.name.trim(),
          age: normalizePatientAge(patient.age),
          gender: patient.gender,
          bloodGroup: patient.bloodGroup ?? null,
          contactNumber: patient.contactNumber.trim(),
          address: patient.address?.trim() ?? "",
          guardian: {
            name: patient.guardian?.name?.trim() ?? "",
            relation: patient.guardian?.relation?.trim() ?? "",
            contactNumber: patient.guardian?.contactNumber?.trim() ?? "",
          },
          updatedAt: null,
          updatedBy: null,
        },
        disease: {
          description: disease?.description?.trim() ?? "",
          medicalHistory: disease?.medicalHistory?.trim() ?? "",
        },
        space: {
          spaceId: toObjectId(spaceId),
          spaceName: space.name,
          bedNumber: space.multiBed ? bedNumber : null,
          chargePerDay: space.chargePerDay,
          fromDate: admittedAt,
        },
        supervisorDoctor: { doctorId: toObjectId(doctorId), name: doctor.name, degree: doctor.degree ?? "" },
        doctorHistory: [],
        referrer: resolvedReferrer,
        dealType,
        packageDeal: dealType === "package" ? packageDeal : null,
        wardHistory: [],
        expenses: [],
        reports: [],
        payments: [],
        discounts: [],
        admittedAt,
        admittedBy: by(req),
        releasedAt: null,
        releasedBy: null,
        // Set only at release time (see /release handler). A real BSON Date so
        // the purgeAt_ttl index can act on it — everything else in this schema
        // is a numeric epoch timestamp, purgeAt is the deliberate exception.
        purgeAt: null,
        created: { at: admittedAt, by: by(req) },
        deletion: { at: null, by: null, note: null },
      };

      if (space.multiBed) {
        await spacesCol().updateOne(
          { _id: toObjectId(spaceId), labId: labId(req) },
          { $push: { "multiBedConf.booked": bedNumber }, $set: { updated: { at: admittedAt, by: by(req) } } },
        );
      } else {
        await spacesCol().updateOne(
          { _id: toObjectId(spaceId), labId: labId(req) },
          { $set: { reserved: true, reservedNote: `IPD: ${admissionId}`, updated: { at: admittedAt, by: by(req) } } },
        );
      }

      const result = await col().insertOne(doc);
      return reply.code(201).send({ _id: result.insertedId, admissionId });
    } catch (err) {
      req.log.error(err);
      return reply.code(500).send({ error: "Failed to admit patient" });
    }
  });

  // ── PATCH /indoor-patient/:id/patient-info ───────────────────────────────────
  fastify.patch(
    "/indoor-patient/:id/patient-info",
    { ...updatePatientInfoSchema, ...requireEdit },
    async (req, reply) => {
      try {
        const _id = toObjectId(req.params.id);
        if (!_id) return reply.code(400).send({ error: "Invalid patient ID" });
        const { patient } = req.body;

        const updatedAt = now();
        const result = await col().updateOne(
          { _id, ...notDeletedFilter(req) },
          {
            $set: {
              "patient.name": patient.name.trim(),
              "patient.age": normalizePatientAge(patient.age),
              "patient.gender": patient.gender,
              "patient.bloodGroup": patient.bloodGroup ?? null,
              "patient.contactNumber": patient.contactNumber.trim(),
              "patient.address": patient.address?.trim() ?? "",
              "patient.guardian": {
                name: patient.guardian?.name?.trim() ?? "",
                relation: patient.guardian?.relation?.trim() ?? "",
                contactNumber: patient.guardian?.contactNumber?.trim() ?? "",
              },
              "patient.updatedAt": updatedAt,
              "patient.updatedBy": by(req),
              updated: { at: updatedAt, by: by(req) },
            },
          },
        );
        if (result.matchedCount === 0) return reply.code(404).send({ error: "Patient not found" });
        return reply.send({ success: true });
      } catch (err) {
        req.log.error(err);
        return reply.code(500).send({ error: "Failed to update patient info" });
      }
    },
  );

  // ── PATCH /indoor-patient/:id/clinical-notes ─────────────────────────────────
  fastify.patch(
    "/indoor-patient/:id/clinical-notes",
    { ...updateClinicalNotesSchema, ...requireEdit },
    async (req, reply) => {
      try {
        const _id = toObjectId(req.params.id);
        if (!_id) return reply.code(400).send({ error: "Invalid patient ID" });
        const { disease } = req.body;

        const updatedAt = now();
        const result = await col().updateOne(
          { _id, ...notDeletedFilter(req) },
          {
            $set: {
              "disease.description": disease.description?.trim() ?? "",
              "disease.medicalHistory": disease.medicalHistory?.trim() ?? "",
              "disease.updatedAt": updatedAt,
              "disease.updatedBy": by(req),
              updated: { at: updatedAt, by: by(req) },
            },
          },
        );
        if (result.matchedCount === 0) return reply.code(404).send({ error: "Patient not found" });
        return reply.send({ success: true });
      } catch (err) {
        req.log.error(err);
        return reply.code(500).send({ error: "Failed to update clinical notes" });
      }
    },
  );

  // ── PATCH /indoor-patient/:id/transfer-ward ──────────────────────────────────
  fastify.patch("/indoor-patient/:id/transfer-ward", { ...transferWardSchema, ...requireEdit }, async (req, reply) => {
    try {
      const _id = toObjectId(req.params.id);
      if (!_id) return reply.code(400).send({ error: "Invalid patient ID" });

      const admission = await col().findOne(
        { _id, ...notDeletedFilter(req) },
        { projection: { status: 1, admissionId: 1, space: 1, admittedAt: 1 } },
      );
      if (!admission) return reply.code(404).send({ error: "Patient not found" });
      if (admission.status !== "admitted") return reply.code(400).send({ error: "Patient is not currently admitted" });

      const { spaceId, bedNumber, note } = req.body;

      if (admission.space?.spaceId?.toString() === toObjectId(spaceId)?.toString())
        return reply.code(400).send({ error: "Patient is already admitted in this cabin" });

      const newSpace = await spacesCol().findOne({ _id: toObjectId(spaceId), labId: labId(req) });
      if (!newSpace) return reply.code(404).send({ error: "Target space not found" });

      if (newSpace.multiBed) {
        if (bedNumber == null) return reply.code(400).send({ error: "bedNumber required for multi-bed space" });
        const { totalNumberOfBed, bedStartingNumber, booked = [] } = newSpace.multiBedConf;
        if (bedNumber < bedStartingNumber || bedNumber >= bedStartingNumber + totalNumberOfBed)
          return reply.code(400).send({ error: "Bed number out of range" });
        if (booked.includes(bedNumber)) return reply.code(409).send({ error: "Bed is already occupied" });
      } else {
        if (newSpace.reserved) return reply.code(409).send({ error: "Target space is already occupied" });
      }

      const oldSpace = admission.space;
      const transferTime = now();

      if (oldSpace.bedNumber != null) {
        await spacesCol().updateOne(
          { _id: oldSpace.spaceId, labId: labId(req) },
          {
            $pull: { "multiBedConf.booked": oldSpace.bedNumber },
            $set: { updated: { at: transferTime, by: by(req) } },
          },
        );
      } else {
        await spacesCol().updateOne(
          { _id: oldSpace.spaceId, labId: labId(req) },
          { $set: { reserved: false, reservedNote: "", updated: { at: transferTime, by: by(req) } } },
        );
      }

      if (newSpace.multiBed) {
        await spacesCol().updateOne(
          { _id: toObjectId(spaceId), labId: labId(req) },
          { $push: { "multiBedConf.booked": bedNumber }, $set: { updated: { at: transferTime, by: by(req) } } },
        );
      } else {
        await spacesCol().updateOne(
          { _id: toObjectId(spaceId), labId: labId(req) },
          {
            $set: {
              reserved: true,
              reservedNote: `IPD: ${admission.admissionId}`,
              updated: { at: transferTime, by: by(req) },
            },
          },
        );
      }

      await col().updateOne(
        { _id, ...notDeletedFilter(req) },
        {
          $set: {
            space: {
              spaceId: toObjectId(spaceId),
              spaceName: newSpace.name,
              bedNumber: newSpace.multiBed ? bedNumber : null,
              chargePerDay: newSpace.chargePerDay,
              fromDate: transferTime,
            },
            updated: { at: transferTime, by: by(req) },
          },
          $push: {
            wardHistory: {
              fromSpaceId: oldSpace.spaceId,
              fromSpaceName: oldSpace.spaceName,
              fromBedNumber: oldSpace.bedNumber,
              toSpaceId: toObjectId(spaceId),
              toSpaceName: newSpace.name,
              toBedNumber: newSpace.multiBed ? bedNumber : null,
              chargePerDay: oldSpace.chargePerDay,
              fromDate: oldSpace.fromDate ?? admission.admittedAt,
              toDate: transferTime,
              movedAt: transferTime,
              movedBy: by(req),
              note: note ?? "",
            },
          },
        },
      );

      return reply.send({ success: true });
    } catch (err) {
      req.log.error(err);
      return reply.code(500).send({ error: "Failed to transfer patient" });
    }
  });

  // ── PATCH /indoor-patient/:id/change-doctor ──────────────────────────────────
  fastify.patch("/indoor-patient/:id/change-doctor", { ...changeDoctorSchema, ...requireEdit }, async (req, reply) => {
    try {
      const _id = toObjectId(req.params.id);
      if (!_id) return reply.code(400).send({ error: "Invalid patient ID" });
      const { doctorId, note } = req.body;

      const admission = await col().findOne({ _id, ...notDeletedFilter(req) }, { projection: { supervisorDoctor: 1 } });
      if (!admission) return reply.code(404).send({ error: "Patient not found" });

      if (admission.supervisorDoctor?.doctorId?.toString() === toObjectId(doctorId)?.toString())
        return reply.code(400).send({ error: "Patient is already under this doctor" });

      const doctor = await doctorsCol().findOne({ _id: toObjectId(doctorId), labId: labId(req) });
      if (!doctor) return reply.code(404).send({ error: "Doctor not found" });

      const changedAt = now();
      await col().updateOne(
        { _id, ...notDeletedFilter(req) },
        {
          $set: {
            supervisorDoctor: { doctorId: toObjectId(doctorId), name: doctor.name, degree: doctor.degree ?? "" },
            updated: { at: changedAt, by: by(req) },
          },
          $push: {
            doctorHistory: {
              previousDoctorId: admission.supervisorDoctor.doctorId,
              previousDoctorName: admission.supervisorDoctor.name,
              newDoctorId: toObjectId(doctorId),
              newDoctorName: doctor.name,
              changedAt,
              changedBy: by(req),
              note: note ?? "",
            },
          },
        },
      );

      return reply.send({ success: true });
    } catch (err) {
      req.log.error(err);
      return reply.code(500).send({ error: "Failed to change doctor" });
    }
  });

  // ── POST /indoor-patient/:id/expense ────────────────────────────────────────
  fastify.post("/indoor-patient/:id/expense", { ...addExpenseSchema, ...requireAddExpense }, async (req, reply) => {
    try {
      const _id = toObjectId(req.params.id);
      if (!_id) return reply.code(400).send({ error: "Invalid patient ID" });
      const { type, itemId, name, price, quantity, note, schemaId, commission } = req.body;

      const addedAt = now();
      const addedBy = by(req);
      const resolvedItemId = itemId ? toObjectId(itemId) : null;

      const update = {
        $push: {
          expenses: {
            type,
            itemId: resolvedItemId,
            name: name.trim(),
            price,
            quantity,
            total: price * quantity,
            // Only tests carry a commission, same as the invoice schema.
            commission: type === "test" ? commission || 0 : 0,
            note: note ?? "",
            addedAt,
            addedBy,
          },
        },
        $set: { updated: { at: addedAt, by: addedBy } },
      };

      if (type === "test" && resolvedItemId) {
        update.$push.reports = schemaId
          ? {
              testId: resolvedItemId,
              name: name.trim(),
              schemaId: toObjectId(schemaId),
              // Mirrors createInvoice: sampleCollectionDate defaults to the
              // moment the test is added, reportDate stays null until filed.
              report: {
                sampleCollectionDate: addedAt,
                reportDate: null,
              },
              isCompleted: false,
              completedAt: null,
              updatedAt: null,
              addedAt,
              addedBy,
            }
          : {
              testId: resolvedItemId,
              name: name.trim(),
              schemaId: null,
              addedAt,
              addedBy,
            };
      }

      const result = await col().updateOne({ _id, ...notDeletedFilter(req) }, update);
      if (result.matchedCount === 0) return reply.code(404).send({ error: "Patient not found" });
      return reply.code(201).send({ success: true });
    } catch (err) {
      req.log.error(err);
      return reply.code(500).send({ error: "Failed to add expense" });
    }
  });
  // ── POST /indoor-patient/:id/discount ────────────────────────────────────────
  fastify.post("/indoor-patient/:id/discount", { ...addDiscountSchema, ...requireDiscount }, async (req, reply) => {
    try {
      const _id = toObjectId(req.params.id);
      if (!_id) return reply.code(400).send({ error: "Invalid patient ID" });
      const { category, amount, providedBy, note } = req.body;

      const admission = await col().findOne(
        { _id, ...notDeletedFilter(req) },
        {
          projection: {
            dealType: 1,
            expenses: 1,
            discounts: 1,
            admittedAt: 1,
            releasedAt: 1,
            space: 1,
            wardHistory: 1,
            packageDeal: 1,
          },
        },
      );
      if (!admission) return reply.code(404).send({ error: "Patient not found" });

      const expenses = admission.expenses ?? [];

      let categoryTotal = 0;

      if (category === "grand-total") {
        const expenseTotal = expenses.reduce((s, e) => s + (e.total ?? e.price * e.quantity), 0);
        const bedTotal = computeBedTotal(admission);
        const packageTotal = admission.dealType === "package" ? (admission.packageDeal?.totalAmount ?? 0) : 0;
        categoryTotal = admission.dealType === "package" ? packageTotal : expenseTotal + bedTotal;
      } else if (category === "bed-charge") {
        // Was previously `Infinity` — meaning bed-charge discounts were unbounded.
        // Now capped at the actual accrued bed total, same as every other category.
        categoryTotal = computeBedTotal(admission);
      } else {
        const typeMap = {
          test: ["test"],
          medicine: ["medicine"],
          product: ["product"],
          other: ["service", "other"],
        };
        const matchTypes = typeMap[category] ?? [category];
        categoryTotal = expenses
          .filter((e) => matchTypes.includes(e.type))
          .reduce((s, e) => s + (e.total ?? e.price * e.quantity), 0);
      }

      const existingDiscount = (admission.discounts ?? [])
        .filter((d) => d.category === category)
        .reduce((s, d) => s + d.amount, 0);

      if (existingDiscount + amount > categoryTotal) {
        return reply.code(400).send({
          error: `Total discount for "${category}" (${existingDiscount + amount}) exceeds category total (${categoryTotal})`,
        });
      }

      const appliedAt = Date.now();
      const result = await col().updateOne(
        { _id, ...notDeletedFilter(req) },
        {
          $push: {
            discounts: {
              category,
              amount,
              providedBy,
              note: note ?? "",
              appliedAt,
              appliedBy: by(req),
            },
          },
          $set: { updated: { at: appliedAt, by: by(req) } },
        },
      );

      if (result.matchedCount === 0) return reply.code(404).send({ error: "Patient not found" });
      return reply.code(201).send({ success: true });
    } catch (err) {
      req.log.error(err);
      return reply.code(500).send({ error: "Failed to apply discount" });
    }
  });

  // ── POST /indoor-patient/:id/payment ────────────────────────────────────────
  // Intentionally unguarded — no permission key exists for payment collection
  // yet (e.g. "collectPayment"). Add one to ALLOWED_PERMISSIONS and the role
  // editor, then gate this route, once that's decided.
  fastify.post("/indoor-patient/:id/payment", addPaymentSchema, async (req, reply) => {
    try {
      const _id = toObjectId(req.params.id);
      if (!_id) return reply.code(400).send({ error: "Invalid patient ID" });
      const { amount, note, paymentMode = "cash" } = req.body;

      const collectedAt = now();
      const result = await col().updateOne(
        { _id, ...notDeletedFilter(req) },
        {
          $push: {
            payments: {
              paymentId: randomUUID(),
              amount,
              mode: paymentMode,
              collectedBy: by(req),
              collectedAt,
              note: note ?? "",
            },
          },
          $set: { updated: { at: collectedAt, by: by(req) } },
        },
      );

      if (result.matchedCount === 0) return reply.code(404).send({ error: "Patient not found" });
      return reply.code(201).send({ success: true });
    } catch (err) {
      req.log.error(err);
      return reply.code(500).send({ error: "Failed to record payment" });
    }
  });

  // ── PATCH /indoor-patient/:id/payment/:paymentId/mode ───────────────────────
  // Only the staff member who originally collected the payment may edit its mode.
  fastify.patch("/indoor-patient/:id/payment/:paymentId/mode", updatePaymentModeSchema, async (req, reply) => {
    try {
      const _id = toObjectId(req.params.id);
      if (!_id) return reply.code(400).send({ error: "Invalid patient ID" });
      const { paymentId } = req.params;
      const { paymentMode } = req.body;

      const admission = await col().findOne({ _id, ...notDeletedFilter(req) }, { projection: { payments: 1 } });
      if (!admission) return reply.code(404).send({ error: "Patient not found" });

      const payment = (admission.payments ?? []).find((p) => p.paymentId === paymentId);
      if (!payment) return reply.code(404).send({ error: "Payment not found" });

      if (payment.collectedBy?.id?.toString() !== req.user.id) {
        return reply.code(403).send({ error: "Only the staff member who collected this payment can edit its mode" });
      }

      if (payment.mode === paymentMode) return reply.send({ success: true });

      const updatedAt = now();
      await col().updateOne(
        { _id, ...notDeletedFilter(req) },
        {
          $set: {
            "payments.$[p].mode": paymentMode,
            "payments.$[p].modeUpdatedAt": updatedAt,
            "payments.$[p].modeUpdatedBy": by(req),
            updated: { at: updatedAt, by: by(req) },
          },
        },
        { arrayFilters: [{ "p.paymentId": paymentId }] },
      );

      return reply.send({ success: true });
    } catch (err) {
      req.log.error(err);
      return reply.code(500).send({ error: "Failed to update payment mode" });
    }
  });

  // ── PATCH /indoor-patient/:id/release ────────────────────────────────────────
  fastify.patch("/indoor-patient/:id/release", { ...releasePatientSchema, ...requireRelease }, async (req, reply) => {
    try {
      const _id = toObjectId(req.params.id);
      if (!_id) return reply.code(400).send({ error: "Invalid patient ID" });

      const admission = await col().findOne(
        { _id, ...notDeletedFilter(req) },
        { projection: { status: 1, admissionId: 1, space: 1, admittedAt: 1 } },
      );
      if (!admission) return reply.code(404).send({ error: "Patient not found" });
      if (admission.status !== "admitted") return reply.code(400).send({ error: "Patient is already released" });

      const { note } = req.body ?? {};
      const releaseTime = now();

      if (admission.space.bedNumber != null) {
        await spacesCol().updateOne(
          { _id: admission.space.spaceId, labId: labId(req) },
          {
            $pull: { "multiBedConf.booked": admission.space.bedNumber },
            $set: { updated: { at: releaseTime, by: by(req) } },
          },
        );
      } else {
        await spacesCol().updateOne(
          { _id: admission.space.spaceId, labId: labId(req) },
          { $set: { reserved: false, reservedNote: "", updated: { at: releaseTime, by: by(req) } } },
        );
      }

      await col().updateOne(
        { _id, ...notDeletedFilter(req) },
        {
          $set: {
            status: "released",
            releasedAt: releaseTime,
            releasedBy: by(req),
            // Real BSON Date (unlike the rest of this schema's numeric timestamps) —
            // required for the purgeAt_ttl index to fire. Patient is hard-deleted
            // by MongoDB ~365 days from now, permanently and unrecoverably.
            purgeAt: new Date(releaseTime + ONE_YEAR_MS),
            updated: { at: releaseTime, by: by(req) },
          },
          $push: {
            wardHistory: {
              fromSpaceId: admission.space.spaceId,
              fromSpaceName: admission.space.spaceName,
              fromBedNumber: admission.space.bedNumber,
              toSpaceId: null,
              toSpaceName: null,
              toBedNumber: null,
              chargePerDay: admission.space.chargePerDay,
              fromDate: admission.space.fromDate ?? admission.admittedAt,
              toDate: releaseTime,
              movedAt: releaseTime,
              movedBy: by(req),
              note: note ?? "Patient discharged",
            },
          },
        },
      );

      return reply.send({ success: true });
    } catch (err) {
      req.log.error(err);
      return reply.code(500).send({ error: "Failed to release patient" });
    }
  });

  // ── DELETE /indoor-patient/:id ───────────────────────────────────────────────
  fastify.delete("/indoor-patient/:id", { ...softDeletePatientSchema, ...requireDelete }, async (req, reply) => {
    try {
      const _id = toObjectId(req.params.id);
      if (!_id) return reply.code(400).send({ error: "Invalid patient ID" });

      const admission = await col().findOne({ _id, ...notDeletedFilter(req) }, { projection: { status: 1, space: 1 } });
      if (!admission) return reply.code(404).send({ error: "Patient not found" });

      const { note } = req.body ?? {};
      const deletedAt = now();

      // Free up the space if the patient is still admitted at time of deletion,
      // mirroring the release-time cleanup so beds/cabins don't stay stuck reserved.
      if (admission.status === "admitted") {
        if (admission.space.bedNumber != null) {
          await spacesCol().updateOne(
            { _id: admission.space.spaceId, labId: labId(req) },
            {
              $pull: { "multiBedConf.booked": admission.space.bedNumber },
              $set: { updated: { at: deletedAt, by: by(req) } },
            },
          );
        } else {
          await spacesCol().updateOne(
            { _id: admission.space.spaceId, labId: labId(req) },
            { $set: { reserved: false, reservedNote: "", updated: { at: deletedAt, by: by(req) } } },
          );
        }
      }

      const result = await col().updateOne(
        { _id, ...notDeletedFilter(req) },
        {
          $set: {
            deletion: { at: deletedAt, by: by(req), note: note ?? "" },
            updated: { at: deletedAt, by: by(req) },
          },
        },
      );

      if (result.matchedCount === 0) return reply.code(404).send({ error: "Patient not found" });
      return reply.send({ success: true });
    } catch (err) {
      req.log.error(err);
      return reply.code(500).send({ error: "Failed to delete patient" });
    }
  });

  // Dependency API Call
  // ──GET Required Data while adding items to a patient────────────────────────────────────────────
  fastify.get("/indoor-patients/add-items/required-data", async (req, reply) => {
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
      return reply.code(500).send({ error: "Failed to fetch required data for adding items to indoor patient" });
    }
  });
}

export default indoorPatientRoutes;
