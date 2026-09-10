import toObjectId from "../../utils/db.js";

// ─── Reusable Schema Fragments ────────────────────────────────────────────────

const objectIdSchema = {
  type: "string",
  minLength: 24,
  maxLength: 24,
  description: "MongoDB ObjectId (24-character hex string)",
};

const testIdParamSchema = {
  type: "object",
  required: ["testId"],
  properties: {
    testId: { ...objectIdSchema, description: "ObjectId of the test" },
  },
};

const schemaIdParamSchema = {
  type: "object",
  required: ["schemaId"],
  properties: {
    schemaId: { ...objectIdSchema, description: "ObjectId of the schema" },
  },
};

const moneyFieldSchema = {
  type: "number",
  minimum: 0,
  maximum: 1000000,
  multipleOf: 0.01,
};

// Fixed testCatalog category every lab/customer-created ("manual") test is
// filed under — a single pre-seeded { _id: ..., name: "Created by Labs" }
// document in testCategories, shared across all labs, distinct from the
// real catalog categories.
const MANUAL_TEST_CATEGORY_ID = "6aa0f23328b36d7a2a1819d6";

// ─── Duplicate-name detection (manual tests) ───────────────────────────────
// Mirrors the admin catalog's own normalizeTestName/levenshtein pair
// (testRoutes.js, admin side) exactly, so a name collides the same way on
// both sides of the app. Keep these two in sync if either changes.
const FUZZY_SIMILARITY_THRESHOLD = 0.82;
const FUZZY_MAX_RESULTS = 5;

// Reduces a test name to a canonical comparison key by stripping everything
// that's just formatting: case, whitespace, punctuation (., -, (), etc).
// This is the key stored on `tests` (manual docs only) and on the
// `testCatalog` doc created alongside it, backed by a unique index, so
// exact-duplicate detection is an O(1) indexed lookup and race-safe under
// concurrent writes.
function normalizeTestName(name) {
  return name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]/g, "");
}

// Standard edit-distance calculation. Used only for the *soft* fuzzy-match
// warning layer — exact duplicates are caught separately via nameKey.
function levenshtein(a, b) {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;

  let prevRow = Array.from({ length: b.length + 1 }, (_, i) => i);

  for (let i = 1; i <= a.length; i++) {
    const currRow = [i];
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      currRow[j] = Math.min(
        currRow[j - 1] + 1, // insertion
        prevRow[j] + 1, // deletion
        prevRow[j - 1] + cost, // substitution
      );
    }
    prevRow = currRow;
  }

  return prevRow[b.length];
}

// ─── Schemas ──────────────────────────────────────────────────────────────────

const getAllTestsSchema = {
  schema: {
    tags: ["Tests"],
    summary: "Get all tests for the lab",
    querystring: {
      type: "object",
      properties: {
        sortBy: {
          type: "string",
          enum: ["name", "categoryId"],
          description: "Field to sort by (default: name)",
        },
      },
    },
  },
};

const getCategoriesSchema = {
  schema: {
    tags: ["Tests"],
    summary: "Get all test categories",
  },
};

const getCatalogSchema = {
  schema: {
    tags: ["Tests"],
    summary: "Get all tests from the global test catalog, annotated with online status and default schema",
  },
};

const getTestSchemaByTestIdSchema = {
  schema: {
    tags: ["Tests"],
    summary: "Get report schemas for a test",
    params: testIdParamSchema,
  },
};

const getTestByIdSchema = {
  schema: {
    tags: ["Tests"],
    summary: "Get a single test by ID",
    params: testIdParamSchema,
  },
};

const getSchemaByIdSchema = {
  schema: {
    tags: ["Schemas"],
    summary: "Get a report schema by ID",
    params: schemaIdParamSchema,
  },
};

const createTestSchema = {
  schema: {
    tags: ["Tests"],
    summary: "Create a new test for the lab",
    body: {
      type: "object",
      required: ["name", "testId"],
      additionalProperties: false,
      properties: {
        name: {
          type: "string",
          minLength: 2,
          maxLength: 500,
          pattern: "^[a-zA-Z0-9\\s\\-_%/&,:'.()\\[\\]{}+]+$",
          description: "Name of the test",
        },
        testId: {
          ...objectIdSchema,
          description: "ObjectId of the global catalog test",
        },
        categoryId: {
          ...objectIdSchema,
          nullable: true,
          description: "ObjectId of the test category (optional)",
        },
        schemaId: {
          ...objectIdSchema,
          nullable: true,
          description:
            "ObjectId of the report schema (optional). If omitted and the catalog test has a defaultSchemaId, that is used automatically.",
        },
        price: {
          ...moneyFieldSchema,
          description: "Price of the test (max 2 decimal places)",
        },
        commission: {
          ...moneyFieldSchema,
          description: "Referrer/staff commission on this test (max 2 decimal places)",
        },
      },
    },
  },
};

// Manual add — used when a lab can't find a test in the global catalog via
// GET /test/catalog. Only takes a name + price (+ optional commission); the
// route itself creates the catalog entry (under the fixed
// MANUAL_TEST_CATEGORY_ID category) and the lab's own test in one go, so
// there is no separate testId to supply.
const createManualTestSchema = {
  schema: {
    tags: ["Tests"],
    summary: "Manually add a test not found in the global catalog (creates both a catalog entry and the lab's test)",
    body: {
      type: "object",
      required: ["name", "price"],
      additionalProperties: false,
      properties: {
        name: {
          type: "string",
          minLength: 2,
          maxLength: 500,
          pattern: "^[a-zA-Z0-9\\s\\-_%/&,:'.()\\[\\]{}+]+$",
          description: "Name of the test",
        },
        price: {
          ...moneyFieldSchema,
          description: "Price of the test (max 2 decimal places)",
        },
        commission: {
          ...moneyFieldSchema,
          description: "Referrer/staff commission on this test (optional, default 0)",
        },
      },
    },
  },
};

// Debounced by the frontend as the lab user types a manual test name.
// Checks against the GLOBAL testCatalog (every lab), not just this lab's
// own tests — because a manual add always creates a new testCatalog doc,
// so a name can collide with any lab's prior manual entry, or with a real
// catalog test the user simply didn't find via GET /test/catalog.
const checkManualDuplicateSchema = {
  schema: {
    tags: ["Tests"],
    summary: "Check whether a manual test name is an exact or near duplicate of any test in the global catalog",
    querystring: {
      type: "object",
      required: ["name"],
      properties: { name: { type: "string", minLength: 1 } },
    },
  },
};

const updateTestPriceSchema = {
  schema: {
    tags: ["Tests"],
    summary: "Update the price of a test",
    params: testIdParamSchema,
    body: {
      type: "object",
      required: ["price"],
      additionalProperties: false,
      properties: {
        price: {
          ...moneyFieldSchema,
          description: "Updated price (max 2 decimal places)",
        },
      },
    },
  },
};

const updateTestCommissionSchema = {
  schema: {
    tags: ["Tests"],
    summary: "Update the commission of a test",
    params: testIdParamSchema,
    body: {
      type: "object",
      required: ["commission"],
      additionalProperties: false,
      properties: {
        commission: {
          ...moneyFieldSchema,
          description: "Updated commission (max 2 decimal places)",
        },
      },
    },
  },
};

const updateTestSchemaIdSchema = {
  schema: {
    tags: ["Tests"],
    summary: "Update (or unset) the report schema of a test",
    params: testIdParamSchema,
    body: {
      type: "object",
      required: ["schemaId"],
      additionalProperties: false,
      properties: {
        schemaId: {
          type: ["string", "null"],
          minLength: 24,
          maxLength: 24,
          description: "Updated report schema ObjectId, or null to unset",
        },
      },
    },
  },
};

const deleteTestSchema = {
  schema: {
    tags: ["Tests"],
    summary: "Hard delete a test",
    params: testIdParamSchema,
  },
};

// ─── Routes ───────────────────────────────────────────────────────────────────

async function testRoutes(fastify) {
  const col = () => fastify.mongo.db.collection("tests");
  const catalogCol = () => fastify.mongo.db.collection("testCatalog");
  const labId = (req) => toObjectId(req.user.labId);

  // Narrowed candidate set for fuzzy matching: pull only docs whose nameKey
  // shares a short prefix with the target, since a genuine typo rarely
  // changes the first couple characters. Queries the GLOBAL testCatalog —
  // not this lab's own `tests` — because a manual add always creates a
  // fresh testCatalog doc, so the thing that can actually collide is the
  // shared catalog (across every lab), same collection/index the admin
  // route (testRoutes.js, admin side) dedups against. Keeps this cheap
  // without a text index — same approach as the admin catalog's own
  // findFuzzyMatches.
  async function findFuzzyMatches(nameKey, excludeId) {
    if (nameKey.length < 2) return [];
    const prefix = nameKey.slice(0, 2);

    const candidates = await catalogCol()
      .find(
        {
          nameKey: { $regex: `^${prefix}` },
          ...(excludeId ? { _id: { $ne: excludeId } } : {}),
        },
        { projection: { name: 1, nameKey: 1 } },
      )
      .toArray();

    const fuzzy = [];
    for (const c of candidates) {
      if (c.nameKey === nameKey) continue; // exact matches are handled separately
      const dist = levenshtein(nameKey, c.nameKey);
      const similarity = 1 - dist / Math.max(nameKey.length, c.nameKey.length);
      if (similarity >= FUZZY_SIMILARITY_THRESHOLD) fuzzy.push({ ...c, similarity });
    }

    return fuzzy.sort((a, b) => b.similarity - a.similarity).slice(0, FUZZY_MAX_RESULTS);
  }

  fastify.addHook("onRequest", fastify.authenticate);
  fastify.addHook("onRequest", fastify.authorize("manageTests"));

  // ── GET /test/all ─────────────────────────────────────────────────────────
  fastify.get("/test/all", getAllTestsSchema, async (req, reply) => {
    try {
      const validSortFields = ["name", "categoryId"];
      const sortField = validSortFields.includes(req.query.sortBy) ? req.query.sortBy : "name";

      const tests = await col()
        .find({ labId: labId(req) })
        .sort({ [sortField]: 1 })
        .toArray();

      return reply.send(tests);
    } catch (err) {
      req.log.error(err);
      return reply.code(500).send({ error: "Failed to fetch tests" });
    }
  });

  // ── GET /test/categories ──────────────────────────────────────────────────
  fastify.get("/test/categories", getCategoriesSchema, async (req, reply) => {
    try {
      const list = await fastify.mongo.db.collection("testCategories").find({}).toArray();
      return reply.send(list);
    } catch (err) {
      req.log.error(err);
      return reply.code(500).send({ error: "Failed to fetch test categories" });
    }
  });

  // ── GET /test/catalog ─────────────────────────────────────────────────────
  // Annotates each catalog test with isOnline + schemaId derived from
  // testCatalog.defaultSchemaId (set via schemaRoutes.js set-default route),
  // so the "add test" UI can show which catalog tests are online and
  // pre-fill/display their default schema before a lab attaches one.
  fastify.get("/test/catalog", getCatalogSchema, async (req, reply) => {
    try {
      const list = await catalogCol().find({}).toArray();
      const annotated = list.map((doc) => ({
        ...doc,
        isOnline: !!doc.defaultSchemaId,
      }));
      return reply.send(annotated);
    } catch (err) {
      req.log.error(err);
      return reply.code(500).send({ error: "Failed to fetch test catalog" });
    }
  });

  // ── GET /test/manual/check-duplicate?name=... ────────────────────────────
  // Debounced by the frontend as the user types a manual test name — same
  // contract as the admin catalog's GET /test/check-duplicate, and now
  // querying the same testCatalog collection (globally, not per-lab), since
  // that's the collection a manual add actually writes a new doc into.
  // `exact` blocks submission client-side; `fuzzy` matches are
  // informational only.
  fastify.get("/test/manual/check-duplicate", { ...checkManualDuplicateSchema }, async (req, reply) => {
    try {
      const nameKey = normalizeTestName(req.query.name);
      if (!nameKey) return reply.send({ exact: null, fuzzy: [] });

      const exact = await catalogCol().findOne({ nameKey }, { projection: { name: 1 } });
      const fuzzy = exact ? [] : await findFuzzyMatches(nameKey);

      return reply.send({ exact, fuzzy });
    } catch (err) {
      req.log.error(err);
      return reply.code(500).send({ error: "Failed to check duplicate test name" });
    }
  });

  // ── GET /test/schema/:testId ──────────────────────────────────────────────
  // NOTE: no longer filters on isActive — testSchemas docs don't reliably
  // carry that field, so filtering on it was hiding all formats. Returns
  // every schema for the test.
  fastify.get("/test/schema/:testId", getTestSchemaByTestIdSchema, async (req, reply) => {
    try {
      const testId = toObjectId(req.params.testId);
      if (!testId) return reply.code(400).send({ error: "Invalid test ID" });

      const list = await fastify.mongo.db.collection("testSchemas").find({ testId }).toArray();
      return reply.send(list);
    } catch (err) {
      req.log.error(err);
      return reply.code(500).send({ error: "Failed to fetch test schemas" });
    }
  });

  // ── GET /test/:testId ─────────────────────────────────────────────────────
  fastify.get("/test/:testId", getTestByIdSchema, async (req, reply) => {
    try {
      const _id = toObjectId(req.params.testId);
      if (!_id) return reply.code(400).send({ error: "Invalid test ID" });

      const test = await col().findOne({ _id, labId: labId(req) });
      if (!test) return reply.code(404).send({ error: "Test not found" });
      return reply.send(test);
    } catch (err) {
      req.log.error(err);
      return reply.code(500).send({ error: "Failed to fetch test" });
    }
  });

  // ── GET /schema/:schemaId ─────────────────────────────────────────────────
  fastify.get("/schema/:schemaId", getSchemaByIdSchema, async (req, reply) => {
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

  // ── POST /test ────────────────────────────────────────────────────────────
  // If schemaId is omitted, falls back to the catalog test's defaultSchemaId
  // (whatever set-default currently points to) — so online tests get wired
  // to a schema automatically on add, without the caller having to know it.
  fastify.post("/test", { ...createTestSchema }, async (req, reply) => {
    try {
      const { name, testId, categoryId, schemaId, price, commission } = req.body;

      const catalogTestId = toObjectId(testId);
      if (!catalogTestId) return reply.code(400).send({ error: "Invalid catalog test ID" });

      const catalogTest = await catalogCol().findOne({ _id: catalogTestId });
      if (!catalogTest) return reply.code(422).send({ error: "Catalog test does not exist" });

      const finalPrice = price ?? 0;
      const finalCommission = commission ?? 0;
      if (finalCommission > finalPrice) {
        return reply.code(400).send({ error: "Commission cannot exceed price" });
      }

      const existing = await col().findOne({ labId: labId(req), testId: catalogTestId });
      if (existing) return reply.code(409).send({ error: "Test already registered" });

      const finalSchemaId = schemaId ? toObjectId(schemaId) : (catalogTest.defaultSchemaId ?? null);

      const doc = {
        labId: labId(req),
        name: name.trim(),
        testId: catalogTestId, // ← ObjectId reference to catalog test, consistent with categoryId/schemaId
        categoryId: categoryId ? toObjectId(categoryId) : null,
        schemaId: finalSchemaId, // ← explicit body value wins; else falls back to catalog's defaultSchemaId
        price: finalPrice,
        commission: finalCommission,
        createdAt: Date.now(),
      };

      const result = await col().insertOne(doc);
      return reply.code(201).send({ _id: result.insertedId, ...doc });
    } catch (err) {
      req.log.error(err);
      return reply.code(500).send({ error: "Failed to create test" });
    }
  });

  // ── POST /test/manual ─────────────────────────────────────────────────────
  // Used when a lab searches the global catalog (GET /test/catalog) and
  // can't find the test they need. Unlike POST /test above, there is no
  // existing catalog testId to reference — this route creates one:
  //   1. a new testCatalog doc, filed under the fixed
  //      MANUAL_TEST_CATEGORY_ID ("Created by Labs") category, tagged with
  //      which lab/staff added it (addedBylab / addedbyUser) so it's
  //      traceable even though it's now visible to every lab via the shared
  //      catalog;
  //   2. the lab's own tests doc referencing that new catalog _id as
  //      testId, same shape as POST /test.
  // schemaId/isOnline start null/false — format gets attached later via the
  // existing FormatModal flow, same as any other test.
  //
  // Duplicate detection: `nameKey` is the normalized comparison key
  // (normalizeTestName above), checked against the GLOBAL testCatalog —
  // not this lab's own `tests` — because this route always creates a new
  // testCatalog doc, so that's the collection whose uniqueness actually
  // matters (and is exactly what the admin route's own unique index on
  // testCatalog.nameKey already enforces). The findOne below gives a clean
  // 409 in the common case; the E11000 catch on the catalog insert is the
  // actual race-safe guarantee under concurrent writes from different labs.
  fastify.post("/test/manual", { ...createManualTestSchema }, async (req, reply) => {
    try {
      const { name, price, commission } = req.body;
      const trimmedName = name.trim();

      const finalPrice = price ?? 0;
      const finalCommission = commission ?? 0;
      if (finalCommission > finalPrice) {
        return reply.code(400).send({ error: "Commission cannot exceed price" });
      }

      // Case/formatting-insensitive duplicate check against the shared
      // testCatalog (every lab) — matches "S. GPT"/"S GPT"/"S-GPT" etc.
      // against any prior manual entry or real catalog test, not just this
      // lab's own tests.
      const nameKey = normalizeTestName(trimmedName);

      const existingCatalog = await catalogCol().findOne({ nameKey }, { projection: { name: 1 } });
      if (existingCatalog) {
        // Kept as `error` (not `message`) to match this file's response
        // shape everywhere else; existingTestId is extra, non-breaking.
        return reply.code(409).send({
          error: `A test named "${existingCatalog.name}" already exists in the catalog`,
          existingTestId: existingCatalog._id,
        });
      }

      const categoryId = toObjectId(MANUAL_TEST_CATEGORY_ID);

      const catalogDoc = {
        name: trimmedName,
        nameKey, // ← unique-indexed comparison key on testCatalog, same
        //   field/index the admin route's own dedup relies on
        categoryId,
        defaultSchemaId: null,
        addedBylab: labId(req),
        addedbyUser: {
          id: toObjectId(req.user.id),
          name: req.user.name,
        },
      };

      let catalogResult;
      try {
        catalogResult = await catalogCol().insertOne(catalogDoc);
      } catch (err) {
        if (err.code === 11000) return reply.code(409).send({ error: "This test already exists" });
        throw err;
      }

      const testDoc = {
        labId: labId(req),
        name: trimmedName,
        testId: catalogResult.insertedId, // ← generated just above, not an existing catalog entry
        categoryId,
        schemaId: null,
        price: finalPrice,
        commission: finalCommission,
        createdAt: Date.now(),
      };

      const testResult = await col().insertOne(testDoc);

      return reply.code(201).send({ _id: testResult.insertedId, ...testDoc });
    } catch (err) {
      req.log.error(err);
      return reply.code(500).send({ error: "Failed to create manual test" });
    }
  });

  // ── PATCH /test/:testId/price ─────────────────────────────────────────────
  fastify.patch("/test/:testId/price", { ...updateTestPriceSchema }, async (req, reply) => {
    try {
      const _id = toObjectId(req.params.testId);
      if (!_id) return reply.code(400).send({ error: "Invalid test ID" });

      const { price } = req.body;

      const existing = await col().findOne({ _id, labId: labId(req) }, { projection: { commission: 1 } });
      if (!existing) return reply.code(404).send({ error: "Test not found" });
      if (price < (existing.commission ?? 0)) {
        return reply.code(400).send({ error: "Price cannot be less than the existing commission" });
      }

      const update = {
        price,
        updated: { at: Date.now(), by: { id: toObjectId(req.user.id), name: req.user.name } },
      };

      const result = await col().updateOne({ _id, labId: labId(req) }, { $set: update });
      if (result.matchedCount === 0) return reply.code(404).send({ error: "Test not found" });

      const updated = await col().findOne({ _id, labId: labId(req) });
      return reply.send(updated);
    } catch (err) {
      req.log.error(err);
      return reply.code(500).send({ error: "Failed to update test price" });
    }
  });

  // ── PATCH /test/:testId/commission ────────────────────────────────────────
  fastify.patch("/test/:testId/commission", { ...updateTestCommissionSchema }, async (req, reply) => {
    try {
      const _id = toObjectId(req.params.testId);
      if (!_id) return reply.code(400).send({ error: "Invalid test ID" });

      const { commission } = req.body;

      const existing = await col().findOne({ _id, labId: labId(req) }, { projection: { price: 1 } });
      if (!existing) return reply.code(404).send({ error: "Test not found" });
      if (commission > (existing.price ?? 0)) {
        return reply.code(400).send({ error: "Commission cannot exceed price" });
      }

      const update = {
        commission,
        updated: { at: Date.now(), by: { id: toObjectId(req.user.id), name: req.user.name } },
      };

      const result = await col().updateOne({ _id, labId: labId(req) }, { $set: update });
      if (result.matchedCount === 0) return reply.code(404).send({ error: "Test not found" });

      const updated = await col().findOne({ _id, labId: labId(req) });
      return reply.send(updated);
    } catch (err) {
      req.log.error(err);
      return reply.code(500).send({ error: "Failed to update test commission" });
    }
  });

  // ── PATCH /test/:testId/schema ────────────────────────────────────────────
  fastify.patch("/test/:testId/schema", { ...updateTestSchemaIdSchema }, async (req, reply) => {
    try {
      const _id = toObjectId(req.params.testId);
      if (!_id) return reply.code(400).send({ error: "Invalid test ID" });

      const { schemaId } = req.body;
      const update = {
        schemaId: schemaId ? toObjectId(schemaId) : null,
        updated: { at: Date.now(), by: { id: toObjectId(req.user.id), name: req.user.name } },
      };

      const result = await col().updateOne({ _id, labId: labId(req) }, { $set: update });
      if (result.matchedCount === 0) return reply.code(404).send({ error: "Test not found" });

      const updated = await col().findOne({ _id, labId: labId(req) });
      return reply.send(updated);
    } catch (err) {
      req.log.error(err);
      return reply.code(500).send({ error: "Failed to update test schema" });
    }
  });

  // ── DELETE /test/:testId ──────────────────────────────────────────────────
  fastify.delete("/test/:testId", { ...deleteTestSchema }, async (req, reply) => {
    try {
      const _id = toObjectId(req.params.testId);
      if (!_id) return reply.code(400).send({ error: "Invalid test ID" });

      const result = await col().deleteOne({ _id, labId: labId(req) });
      if (result.deletedCount === 0) return reply.code(404).send({ error: "Test not found" });
      return reply.send({ success: true });
    } catch (err) {
      req.log.error(err);
      return reply.code(500).send({ error: "Failed to delete test" });
    }
  });
}

export default testRoutes;
