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
  fastify.post("/test/manual", { ...createManualTestSchema }, async (req, reply) => {
    try {
      const { name, price, commission } = req.body;
      const trimmedName = name.trim();

      const finalPrice = price ?? 0;
      const finalCommission = commission ?? 0;
      if (finalCommission > finalPrice) {
        return reply.code(400).send({ error: "Commission cannot exceed price" });
      }

      // Case-insensitive duplicate check against this lab's own tests only —
      // a manual test only needs to be unique within the lab that's adding
      // it, not across the whole shared catalog.
      const escapedName = trimmedName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const existing = await col().findOne({
        labId: labId(req),
        name: { $regex: `^${escapedName}$`, $options: "i" },
      });
      if (existing) return reply.code(409).send({ error: "A test with this name already exists" });

      const categoryId = toObjectId(MANUAL_TEST_CATEGORY_ID);

      const catalogDoc = {
        name: trimmedName,
        categoryId,
        defaultSchemaId: null,
        addedBylab: labId(req),
        addedbyUser: {
          id: toObjectId(req.user.id),
          name: req.user.name,
        },
      };
      const catalogResult = await catalogCol().insertOne(catalogDoc);

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
