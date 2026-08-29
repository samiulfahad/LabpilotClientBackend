// tutor-cv.routes.js
// Requires: fastify decorated with `fastify.mongo` ({ db, ObjectId })
// Requires: bcryptjs -> npm i bcryptjs

import bcrypt from "bcryptjs";

const OID_PATTERN = "^[0-9a-fA-F]{24}$";
const PIN_PATTERN = "^\\d{5,6}$";
const PHONE_PATTERN = "^01[3-9]\\d{8}$";

const CURRENT_YEAR = new Date().getFullYear();
const MAX_PIN_ATTEMPTS = 5;
const LOCK_MINUTES = 15;

// ---------------------------------------------------------------------------
// Static config (single source of truth — served to the frontend via
// GET /tutor-cv-meta so dropdowns/subject lists never drift out of sync).
// ---------------------------------------------------------------------------

const BOARDS = [
  "Dhaka",
  "Rajshahi",
  "Comilla",
  "Jessore",
  "Chattogram",
  "Barishal",
  "Sylhet",
  "Dinajpur",
  "Mymensingh",
  "Madrasah (Dakhil/Alim)",
  "Technical (BTEB)",
  "English Medium (Cambridge/Edexcel)",
];

const SSC_HSC_GROUPS = ["science", "commerce", "arts"];

const CLASS_LEVELS = [
  {
    key: "class_1_5",
    label: "Class 1-5 (Primary)",
    hasGroup: false,
    subjects: [
      "Bangla",
      "English",
      "Mathematics",
      "General Science",
      "Bangladesh & Global Studies",
      "Religion & Moral Education",
      "ICT",
    ],
  },
  {
    key: "class_6_8",
    label: "Class 6-8 (Junior Secondary)",
    hasGroup: false,
    subjects: [
      "Bangla",
      "English",
      "Mathematics",
      "General Science",
      "Bangladesh & Global Studies",
      "ICT",
      "Religion & Moral Education",
    ],
  },
  {
    key: "class_9_10",
    label: "Class 9-10 (SSC)",
    hasGroup: true,
    groups: {
      science: ["Bangla", "English", "Mathematics", "Higher Mathematics", "Physics", "Chemistry", "Biology", "ICT"],
      commerce: [
        "Bangla",
        "English",
        "Mathematics",
        "Accounting",
        "Finance & Banking",
        "Business Organization & Management",
        "Economics",
        "ICT",
      ],
      arts: ["Bangla", "English", "Mathematics", "History", "Civics", "Economics", "Geography", "ICT"],
    },
  },
  {
    key: "class_11_12",
    label: "Class 11-12 (HSC)",
    hasGroup: true,
    groups: {
      science: ["Bangla", "English", "ICT", "Physics", "Chemistry", "Biology", "Higher Mathematics"],
      commerce: [
        "Bangla",
        "English",
        "ICT",
        "Accounting",
        "Business Organization & Management",
        "Finance, Banking & Insurance",
        "Economics",
        "Production Management & Marketing",
      ],
      arts: [
        "Bangla",
        "English",
        "ICT",
        "History",
        "Civics & Good Governance",
        "Economics",
        "Sociology",
        "Social Work",
        "Islamic History & Culture",
        "Logic",
      ],
    },
  },
];

const CLASS_LEVEL_KEYS = CLASS_LEVELS.map((c) => c.key);

// Validates a single teachingSubjects entry:
//   { classLevel, groups?: string[], subjects: string[] }
// For hasGroup levels (SSC/HSC), a tutor may select multiple departments
// (science/commerce/arts) at once — `subjects` is checked against the
// deduped UNION of every selected department's subject list, not just one.
function isValidSubjectSelection(entry) {
  const level = CLASS_LEVELS.find((c) => c.key === entry.classLevel);
  if (!level) return false;

  if (level.hasGroup) {
    if (!Array.isArray(entry.groups) || entry.groups.length === 0) return false;

    const allowed = new Set();
    for (const g of entry.groups) {
      const groupSubjects = level.groups?.[g];
      if (!groupSubjects) return false; // unknown group key
      groupSubjects.forEach((s) => allowed.add(s));
    }
    return entry.subjects.every((s) => allowed.has(s));
  }

  const allowed = level.subjects;
  if (!allowed) return false;
  return entry.subjects.every((s) => allowed.includes(s));
}

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const sscHscSchema = {
  type: "object",
  required: ["passingYear", "group", "result"],
  properties: {
    passingYear: { type: "integer", minimum: 1980, maximum: CURRENT_YEAR + 1 },
    group: { type: "string", enum: SSC_HSC_GROUPS },
    result: { type: "string", minLength: 1, maxLength: 20 },
    board: { type: "string", maxLength: 100 },
  },
};

const degreeSchema = {
  type: "object",
  properties: {
    isRunning: { type: "boolean" },
    degreeName: { type: "string", maxLength: 150 },
    major: { type: "string", maxLength: 150 },
    institution: { type: "string", maxLength: 200 },
    result: { type: "string", maxLength: 20 },
    passingYear: { type: "integer", minimum: 1980, maximum: CURRENT_YEAR + 6 },
  },
};

// NOTE: `groups` (plural, array) replaces the old singular `group` field so a
// tutor can teach across multiple departments (e.g. Science + Commerce) at
// the same class level. Presence/non-emptiness for hasGroup levels is
// enforced in the route handlers (via isValidSubjectSelection), not here,
// since JSON Schema alone can't express "required only if this class level
// has departments."
const teachingSubjectSchema = {
  type: "object",
  required: ["classLevel", "subjects"],
  properties: {
    classLevel: { type: "string", enum: CLASS_LEVEL_KEYS },
    groups: {
      type: "array",
      items: { type: "string", enum: SSC_HSC_GROUPS },
      uniqueItems: true,
    },
    subjects: { type: "array", items: { type: "string" }, minItems: 1 },
  },
};

const academicQualificationSchema = {
  type: "object",
  required: ["ssc", "hsc"],
  properties: {
    ssc: sscHscSchema,
    hsc: sscHscSchema,
    bachelor: degreeSchema,
    masters: degreeSchema,
  },
};

const createBodySchema = {
  type: "object",
  required: ["fullName", "phone", "academicQualification", "teachingSubjects", "pin"],
  properties: {
    fullName: { type: "string", minLength: 2, maxLength: 120 },
    gender: { type: "string", enum: ["male", "female", "other"] },
    phone: { type: "string", pattern: PHONE_PATTERN },
    email: { type: "string", format: "email" },
    bio: { type: "string", maxLength: 500 },
    experienceYears: { type: "number", minimum: 0, maximum: 50 },
    academicQualification: academicQualificationSchema,
    teachingSubjects: { type: "array", minItems: 1, items: teachingSubjectSchema },
    pin: { type: "string", pattern: PIN_PATTERN },
  },
};

const updateBodySchema = {
  type: "object",
  required: ["pin"],
  properties: {
    pin: { type: "string", pattern: PIN_PATTERN },
    fullName: { type: "string", minLength: 2, maxLength: 120 },
    gender: { type: "string", enum: ["male", "female", "other"] },
    phone: { type: "string", pattern: PHONE_PATTERN },
    email: { type: "string", format: "email" },
    bio: { type: "string", maxLength: 500 },
    experienceYears: { type: "number", minimum: 0, maximum: 50 },
    academicQualification: academicQualificationSchema,
    teachingSubjects: { type: "array", minItems: 1, items: teachingSubjectSchema },
  },
};

const pinOnlyBodySchema = {
  type: "object",
  required: ["pin"],
  properties: { pin: { type: "string", pattern: PIN_PATTERN } },
};

const changePinBodySchema = {
  type: "object",
  required: ["currentPin", "newPin"],
  properties: {
    currentPin: { type: "string", pattern: PIN_PATTERN },
    newPin: { type: "string", pattern: PIN_PATTERN },
  },
};

// ---------------------------------------------------------------------------

function maskPhone(phone) {
  if (!phone) return phone;
  return `${phone.slice(0, 3)}XXXX${phone.slice(-3)}`;
}

function maskEmail(email) {
  if (!email) return email;
  const [local, domain] = email.split("@");
  const visible = local.slice(0, 2);
  return `${visible}***@${domain}`;
}

function stripSensitive(doc) {
  if (!doc) return doc;
  const { pinHash, pinAttempts, pinLockedUntil, ...rest } = doc;
  return rest;
}

// Maps a MongoDB duplicate-key error (E11000) on our unique indexes to a
// friendly, field-specific message. Returns null if `err` isn't a dup-key
// error, so callers can fall through to their normal error handling.
function duplicateKeyMessage(err) {
  if (!err || err.code !== 11000) return null;
  const field = Object.keys(err.keyPattern || err.keyValue || {})[0];
  if (field === "phone") return "A CV already exists with this phone number.";
  if (field === "email") return "A CV already exists with this email address.";
  if (field === "cvId") return "Could not generate a unique CV ID — please try again.";
  return "This CV conflicts with an existing entry.";
}

// Generates a random 5-digit CV ID (10000-99999) and checks it isn't already
// taken. This is the tutor/guardian-facing identifier — short and easy to
// read/share, unlike the internal MongoDB _id.
async function generateUniqueCvId(coll) {
  const MAX_ATTEMPTS = 25;
  for (let i = 0; i < MAX_ATTEMPTS; i++) {
    const candidate = String(Math.floor(10000 + Math.random() * 90000));
    const exists = await coll.findOne({ cvId: candidate }, { projection: { _id: 1 } });
    if (!exists) return candidate;
  }
  const err = new Error("Could not generate a unique CV ID. Please try again.");
  err.statusCode = 500;
  throw err;
}

async function tutorCvRoutes(fastify) {
  const collection = () => fastify.mongo.db.collection("tutor_cvs");
  const { ObjectId } = fastify.mongo;

  // ---- One-time index setup ----------------------------------------------
  // phone: always present, must be globally unique.
  // email: optional — the partial filter excludes docs where email isn't a
  //   string (i.e. null/missing), so multiple CVs without an email don't
  //   collide on uniqueness.
  // cvId: the short public-facing ID, also globally unique.
  try {
    await collection().createIndex({ phone: 1 }, { unique: true, name: "uniq_phone" });
    await collection().createIndex(
      { email: 1 },
      { unique: true, partialFilterExpression: { email: { $type: "string" } }, name: "uniq_email" },
    );
    await collection().createIndex({ cvId: 1 }, { unique: true, name: "uniq_cvId" });
  } catch (err) {
    fastify.log.error({ err }, "Failed to ensure tutor_cvs unique indexes");
  }

  // Verifies a submitted PIN against the stored hash, handling the
  // attempt-counter / lockout bookkeeping. Returns the full raw document
  // on success, or throws a reply-shaped error object on failure.
  async function verifyPinOrThrow(id, pin) {
    const _id = new ObjectId(id);
    const doc = await collection().findOne({ _id });
    if (!doc) {
      const err = new Error("CV not found.");
      err.statusCode = 404;
      throw err;
    }

    if (doc.pinLockedUntil && new Date(doc.pinLockedUntil) > new Date()) {
      const minutesLeft = Math.ceil((new Date(doc.pinLockedUntil) - new Date()) / 60000);
      const err = new Error(`Too many wrong PIN attempts. Try again in ${minutesLeft} minute(s).`);
      err.statusCode = 423;
      throw err;
    }

    const isMatch = await bcrypt.compare(pin, doc.pinHash);
    if (!isMatch) {
      const attempts = (doc.pinAttempts || 0) + 1;
      const update = { pinAttempts: attempts };
      if (attempts >= MAX_PIN_ATTEMPTS) {
        update.pinAttempts = 0;
        update.pinLockedUntil = new Date(Date.now() + LOCK_MINUTES * 60000);
      }
      await collection().updateOne({ _id }, { $set: update });
      const err = new Error(
        attempts >= MAX_PIN_ATTEMPTS
          ? `Too many wrong PIN attempts. Try again in ${LOCK_MINUTES} minutes.`
          : "Incorrect PIN.",
      );
      err.statusCode = 401;
      throw err;
    }

    if (doc.pinAttempts || doc.pinLockedUntil) {
      await collection().updateOne({ _id }, { $set: { pinAttempts: 0, pinLockedUntil: null } });
    }

    return doc;
  }

  // ---- Meta (subjects / boards / groups config for frontend dropdowns) ----
  fastify.get(
    "/tutor-cv-meta",
    { schema: { tags: ["tutor-cvs"], summary: "Get form config for tutor CVs" } },
    async () => {
      return { classLevels: CLASS_LEVELS, boards: BOARDS, sscHscGroups: SSC_HSC_GROUPS };
    },
  );

  // ---- BROWSE (public, guardian-facing — no contact info ever included) ----
  fastify.get(
    "/tutors/browse",
    {
      schema: {
        tags: ["tutor-cvs"],
        summary: "Browse active tutors with filters (no phone/email in the response)",
        querystring: {
          type: "object",
          properties: {
            classLevel: { type: "string", enum: CLASS_LEVEL_KEYS },
            group: { type: "string", enum: SSC_HSC_GROUPS },
            subject: { type: "string", maxLength: 100 },
            institute: { type: "string", pattern: OID_PATTERN },
            minExperience: { type: "number", minimum: 0 },
            page: { type: "integer", minimum: 1, default: 1 },
            limit: { type: "integer", minimum: 1, maximum: 50, default: 20 },
          },
        },
      },
    },
    async (req) => {
      const { classLevel, group, subject, institute, minExperience, page = 1, limit = 20 } = req.query;

      const filter = { status: "active" };

      if (typeof minExperience === "number") filter.experienceYears = { $gte: minExperience };
      if (institute) {
        filter.$or = [
          { "academicQualification.bachelor.institution": institute },
          { "academicQualification.masters.institution": institute },
        ];
      }

      // teachingSubjects is an array of { classLevel, groups, subjects }; match
      // on whichever combination of level/department/subject the guardian
      // specified. `groups` is an array field, so matching it against the
      // scalar `group` query param checks whether that array *contains* it.
      if (classLevel || group || subject) {
        const elem = {};
        if (classLevel) elem.classLevel = classLevel;
        if (group) elem.groups = group;
        if (subject) elem.subjects = subject;
        filter.teachingSubjects = { $elemMatch: elem };
      }

      // Contact fields are excluded at the query level (not just stripped after
      // the fact) so they never leave the database for this route.
      const projection = {
        pinHash: 0,
        pinAttempts: 0,
        pinLockedUntil: 0,
        phone: 0,
        email: 0,
      };

      const skip = (page - 1) * limit;

      const [items, total] = await Promise.all([
        collection().find(filter, { projection }).sort({ createdAt: -1 }).skip(skip).limit(limit).toArray(),
        collection().countDocuments(filter),
      ]);

      return {
        items,
        page,
        limit,
        total,
        totalPages: Math.max(1, Math.ceil(total / limit)),
      };
    },
  );

  // ---- CREATE ----
  fastify.post(
    "/tutor-cvs",
    { schema: { tags: ["tutor-cvs"], summary: "Create a tutor CV", body: createBodySchema } },
    async (req, reply) => {
      const body = req.body;

      for (const entry of body.teachingSubjects) {
        const level = CLASS_LEVELS.find((c) => c.key === entry.classLevel);
        if (level?.hasGroup && (!Array.isArray(entry.groups) || entry.groups.length === 0)) {
          return reply
            .code(400)
            .send({ error: `At least one department (science/commerce/arts) is required for ${entry.classLevel}.` });
        }
        if (!isValidSubjectSelection(entry)) {
          return reply.code(400).send({ error: `Invalid subject selection for ${entry.classLevel}.` });
        }
      }

      // Reject up front on an obviously-duplicate phone/email so we don't
      // waste a cvId generation + hash cycle before hitting the unique index.
      const dupe = await collection().findOne(
        {
          $or: [{ phone: body.phone }, ...(body.email ? [{ email: body.email.trim().toLowerCase() }] : [])],
        },
        { projection: { phone: 1, email: 1 } },
      );
      if (dupe) {
        const field = dupe.phone === body.phone ? "phone number" : "email address";
        return reply.code(409).send({ error: `A CV already exists with this ${field}.` });
      }

      const pinHash = await bcrypt.hash(body.pin, 10);
      const cvId = await generateUniqueCvId(collection());

      const doc = {
        cvId,
        fullName: body.fullName.trim(),
        gender: body.gender || null,
        phone: body.phone,
        email: body.email ? body.email.trim().toLowerCase() : null,
        bio: body.bio || null,
        experienceYears: body.experienceYears ?? null,
        academicQualification: body.academicQualification,
        teachingSubjects: body.teachingSubjects,
        pinHash,
        pinAttempts: 0,
        pinLockedUntil: null,
        status: "active",
        createdAt: new Date(),
        updatedAt: null,
      };

      try {
        const result = await collection().insertOne(doc);
        return reply.code(201).send({ _id: result.insertedId, ...stripSensitive(doc) });
      } catch (err) {
        const message = duplicateKeyMessage(err);
        if (message) return reply.code(409).send({ error: message });
        throw err;
      }
    },
  );

  // ---- SEARCH (public, masked — by phone or email) ----
  fastify.get(
    "/tutor-cvs/search",
    {
      schema: {
        tags: ["tutor-cvs"],
        summary: "Search tutor CVs by phone or email (masked results)",
        querystring: {
          type: "object",
          properties: {
            phone: { type: "string", pattern: PHONE_PATTERN },
            email: { type: "string", format: "email" },
          },
        },
      },
    },
    async (req, reply) => {
      const { phone, email } = req.query;
      if (!phone && !email) {
        return reply.code(400).send({ error: "Provide a phone number or email to search." });
      }

      const filter = { status: "active" };
      if (phone) filter.phone = phone;
      if (email) filter.email = email.trim().toLowerCase();

      const results = await collection()
        .find(filter)
        .project({ fullName: 1, phone: 1, email: 1, createdAt: 1 })
        .toArray();

      return results.map((r) => ({
        _id: r._id,
        fullName: r.fullName,
        maskedPhone: maskPhone(r.phone),
        maskedEmail: maskEmail(r.email),
        createdAt: r.createdAt,
      }));
    },
  );

  // ---- VERIFY PIN -> returns full CV for editing ----
  fastify.post(
    "/tutor-cvs/:id/verify-pin",
    {
      schema: {
        tags: ["tutor-cvs"],
        summary: "Verify a CV PIN and fetch the full CV",
        params: { type: "object", properties: { id: { type: "string", pattern: OID_PATTERN } } },
        body: pinOnlyBodySchema,
      },
    },
    async (req, reply) => {
      try {
        const doc = await verifyPinOrThrow(req.params.id, req.body.pin);
        return stripSensitive(doc);
      } catch (err) {
        return reply.code(err.statusCode || 500).send({ error: err.message });
      }
    },
  );

  // ---- UPDATE (requires pin) ----
  fastify.patch(
    "/tutor-cvs/:id",
    {
      schema: {
        tags: ["tutor-cvs"],
        summary: "Update a tutor CV using its PIN",
        params: { type: "object", properties: { id: { type: "string", pattern: OID_PATTERN } } },
        body: updateBodySchema,
      },
    },
    async (req, reply) => {
      try {
        await verifyPinOrThrow(req.params.id, req.body.pin);
      } catch (err) {
        return reply.code(err.statusCode || 500).send({ error: err.message });
      }

      const { pin, ...updates } = req.body;

      if (updates.teachingSubjects) {
        for (const entry of updates.teachingSubjects) {
          const level = CLASS_LEVELS.find((c) => c.key === entry.classLevel);
          if (level?.hasGroup && (!Array.isArray(entry.groups) || entry.groups.length === 0)) {
            return reply.code(400).send({ error: `At least one department is required for ${entry.classLevel}.` });
          }
          if (!isValidSubjectSelection(entry)) {
            return reply.code(400).send({ error: `Invalid subject selection for ${entry.classLevel}.` });
          }
        }
      }

      if (updates.email) updates.email = updates.email.trim().toLowerCase();
      if (updates.fullName) updates.fullName = updates.fullName.trim();

      let result;
      try {
        result = await collection().findOneAndUpdate(
          { _id: new ObjectId(req.params.id) },
          { $set: { ...updates, updatedAt: new Date() } },
          { returnDocument: "after" },
        );
      } catch (err) {
        const message = duplicateKeyMessage(err);
        if (message) return reply.code(409).send({ error: message });
        throw err;
      }

      // MongoDB Node driver v6+ returns the document directly (or null);
      // v5 and earlier wrap it as { value: doc }. Handle both.
      const updatedDoc = result && "value" in result ? result.value : result;

      if (!updatedDoc) return reply.code(404).send({ error: "CV not found." });
      return stripSensitive(updatedDoc);
    },
  );

  // ---- CHANGE PIN ----
  fastify.patch(
    "/tutor-cvs/:id/pin",
    {
      schema: {
        tags: ["tutor-cvs"],
        summary: "Change a CV's PIN",
        params: { type: "object", properties: { id: { type: "string", pattern: OID_PATTERN } } },
        body: changePinBodySchema,
      },
    },
    async (req, reply) => {
      try {
        await verifyPinOrThrow(req.params.id, req.body.currentPin);
      } catch (err) {
        return reply.code(err.statusCode || 500).send({ error: err.message });
      }

      const newPinHash = await bcrypt.hash(req.body.newPin, 10);
      await collection().updateOne(
        { _id: new ObjectId(req.params.id) },
        { $set: { pinHash: newPinHash, updatedAt: new Date() } },
      );
      return reply.code(200).send({ success: true });
    },
  );

  // ---- DELETE (requires pin) ----
  fastify.delete(
    "/tutor-cvs/:id",
    {
      schema: {
        tags: ["tutor-cvs"],
        summary: "Delete a tutor CV using its PIN",
        params: { type: "object", properties: { id: { type: "string", pattern: OID_PATTERN } } },
        body: pinOnlyBodySchema,
      },
    },
    async (req, reply) => {
      try {
        await verifyPinOrThrow(req.params.id, req.body.pin);
      } catch (err) {
        return reply.code(err.statusCode || 500).send({ error: err.message });
      }

      const result = await collection().deleteOne({ _id: new ObjectId(req.params.id) });
      if (result.deletedCount === 0) return reply.code(404).send({ error: "CV not found." });
      return reply.code(200).send({ success: true });
    },
  );
}

export default tutorCvRoutes;

// Recommended indexes (run once):
//   db.tutor_cvs.createIndex({ phone: 1 })
//   db.tutor_cvs.createIndex({ email: 1 })
