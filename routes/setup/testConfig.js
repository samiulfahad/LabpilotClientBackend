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

const categoryIdParamSchema = {
  type: "object",
  required: ["categoryId"],
  properties: {
    categoryId: { ...objectIdSchema, description: "ObjectId of the test category" },
  },
};

// ─── Schemas — report format ───────────────────────────────────────────────────

const getTestSchemaByTestIdSchema = {
  schema: {
    tags: ["Test Config"],
    summary: "Get report schemas for a test",
    params: testIdParamSchema,
  },
};

const getSchemaByIdSchema = {
  schema: {
    tags: ["Test Config"],
    summary: "Get a report schema by ID",
    params: schemaIdParamSchema,
  },
};

const updateTestSchemaIdSchema = {
  schema: {
    tags: ["Test Config"],
    summary: "Update (or unset) the report schema of a test. Changing it clears the test's range overrides.",
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

// ─── Schemas — sample collection room ──────────────────────────────────────────
// There is no separate "rooms" collection — a sample collection room is just a
// short free-text/number label (e.g. "204", "Room 2 - Blood"). A test can carry
// its own label directly (`sampleCollectionRoom`), overriding whatever its
// category defaults to. The category default itself IS persisted, in its own
// lab-scoped `categoryRoomDefaults` collection — unlike the earlier "bulk
// stamp onto every test" approach, this survives a category gaining new tests
// later, and doesn't require re-applying anything by hand. Effective room for
// a test = its own `sampleCollectionRoom` if set, else its category's default,
// else null.

const roomValueSchema = {
  type: ["string", "null"],
  maxLength: 60,
  description: "Room label (e.g. '204' or 'Room 2 - Blood'), or null to unset",
};

const updateTestCollectionRoomSchema = {
  schema: {
    tags: ["Test Config"],
    summary: "Set (or unset) a single test's own sample collection room",
    params: testIdParamSchema,
    body: {
      type: "object",
      required: ["sampleCollectionRoom"],
      additionalProperties: false,
      properties: { sampleCollectionRoom: roomValueSchema },
    },
  },
};

const updateCategoryCollectionRoomSchema = {
  schema: {
    tags: ["Test Config"],
    summary: "Set (or unset) this lab's default sample collection room for a category",
    params: categoryIdParamSchema,
    body: {
      type: "object",
      required: ["sampleCollectionRoom"],
      additionalProperties: false,
      properties: { sampleCollectionRoom: roomValueSchema },
    },
  },
};

// ─── Schemas — reference range / unit overrides ────────────────────────────────
// Stored on the test: test.schema.overrides = [
//   { schemaId, sectionName, fieldName, standardRange?, referenceValue?, unit? }
// ]
// One entry per field, keyed by section name + field name (the admin builder
// rejects duplicate names, so they're unique within a schema) and tied to the
// format (schemaId) it was made on. An entry holds only the keys that were
// changed, so a key's presence tells you what was overridden. If the admin
// renames a section/field, its override just stops applying and the admin
// default shows. The admin's testSchemas document is never touched.
//
// Overrides only make sense for the format they were made on, so whenever a
// test's format changes (including being cleared) the whole array is reset to
// [] — see PATCH /test-config/:testId/schema.

const saveRangeOverrideSchema = {
  schema: {
    tags: ["Test Config"],
    summary: "Set a lab-level reference range / reference value / unit override for one field of a test",
    params: testIdParamSchema,
    body: {
      type: "object",
      required: ["sectionName", "fieldName"],
      additionalProperties: false,
      properties: {
        sectionName: { type: "string", minLength: 1, maxLength: 200 },
        fieldName: { type: "string", minLength: 1, maxLength: 200 },
        standardRange: {
          type: "object",
          required: ["type", "data"],
          properties: {
            type: { type: "string", enum: ["none", "simple", "age", "gender"] },
            data: {},
          },
        },
        referenceValue: {
          type: "object",
          required: ["type", "data"],
          properties: {
            type: { type: "string", enum: ["none", "keyvalue", "text", "textarea"] },
            data: {},
          },
        },
        unit: { type: "string", maxLength: 40 },
      },
    },
  },
};

// ─── Routes ───────────────────────────────────────────────────────────────────
// Test config: settings for a test other than its price/commission (which
// stays in testRoutes.js). Covers report format (schema attachment), sample
// collection room, and reference range / unit overrides.

async function testConfigRoutes(fastify) {
  const testCol = () => fastify.mongo.db.collection("tests");
  const schemaCol = () => fastify.mongo.db.collection("testSchemas");
  const categoryCol = () => fastify.mongo.db.collection("testCategories");
  const categoryRoomCol = () => fastify.mongo.db.collection("categoryRoomDefaults");
  const labId = (req) => toObjectId(req.user.labId);

  fastify.addHook("onRequest", fastify.authenticate);
  fastify.addHook("onRequest", fastify.authorize("manageTestConfig"));

  // ── GET /test-config/tests ─────────────────────────────────────────────────
  // Lab-scoped test list. Each test carries its own `sampleCollectionRoom`
  // (or null). Also computes `effectiveCollectionRoom`: the test's own room
  // if set, else this lab's persisted default for its category, else null —
  // so the client doesn't need to re-derive it from anything. Also adds
  // `formatCount` (how many report formats exist for the test). The full test
  // document is returned, including `schema.overrides`.
  fastify.get("/test-config/tests", async (req, reply) => {
    try {
      const [tests, categoryRooms] = await Promise.all([
        // This lab's tests + how many report formats exist for each, in one
        // aggregation. testSchemas is global; ids are compared as strings so
        // it works whether testId is stored as an ObjectId or a string.
        testCol()
          .aggregate([
            { $match: { labId: labId(req) } },
            { $sort: { name: 1 } },
            {
              $lookup: {
                from: "testSchemas",
                let: { tid: { $toString: "$testId" } },
                pipeline: [{ $match: { $expr: { $eq: [{ $toString: "$testId" }, "$$tid"] } } }, { $count: "n" }],
                as: "formats",
              },
            },
            { $addFields: { formatCount: { $ifNull: [{ $arrayElemAt: ["$formats.n", 0] }, 0] } } },
            { $project: { formats: 0 } },
          ])
          .toArray(),
        categoryRoomCol()
          .find({ labId: labId(req) })
          .toArray(),
      ]);

      const categoryRoomMap = new Map(categoryRooms.map((cr) => [String(cr.categoryId), cr.sampleCollectionRoom]));

      const list = tests.map((test) => ({
        ...test,
        effectiveCollectionRoom: test.sampleCollectionRoom ?? categoryRoomMap.get(String(test.categoryId)) ?? null,
      }));

      return reply.send(list);
    } catch (err) {
      req.log.error(err);
      return reply.code(500).send({ error: "Failed to fetch tests" });
    }
  });

  // ── GET /test-config/categories ────────────────────────────────────────────
  // Global category taxonomy (no labId — same as testSchemas), used to build
  // the category-wise grouped list.
  fastify.get("/test-config/categories", async (req, reply) => {
    try {
      const list = await categoryCol().find({}).sort({ name: 1 }).toArray();
      return reply.send(list);
    } catch (err) {
      req.log.error(err);
      return reply.code(500).send({ error: "Failed to fetch categories" });
    }
  });

  // ── GET /test-config/category-rooms ────────────────────────────────────────
  // This lab's own category → default sample collection room mappings.
  fastify.get("/test-config/category-rooms", async (req, reply) => {
    try {
      const list = await categoryRoomCol()
        .find({ labId: labId(req) })
        .toArray();
      return reply.send(list);
    } catch (err) {
      req.log.error(err);
      return reply.code(500).send({ error: "Failed to fetch category room defaults" });
    }
  });

  // ── PUT /test-config/category/:categoryId/collection-room ─────────────────
  // Sets (or clears) this lab's persisted default room for a category. This
  // does NOT touch any test document — it's read back via
  // `effectiveCollectionRoom` above, so a test added to the category later
  // picks it up automatically, and an individual test can still override it
  // via the per-test PATCH below.
  fastify.put(
    "/test-config/category/:categoryId/collection-room",
    { ...updateCategoryCollectionRoomSchema },
    async (req, reply) => {
      try {
        const categoryId = toObjectId(req.params.categoryId);
        if (!categoryId) return reply.code(400).send({ error: "Invalid category ID" });

        const category = await categoryCol().findOne({ _id: categoryId });
        if (!category) return reply.code(404).send({ error: "Category not found" });

        const raw = req.body.sampleCollectionRoom;
        const room = typeof raw === "string" && raw.trim() !== "" ? raw.trim() : null;

        if (room === null) {
          await categoryRoomCol().deleteOne({ labId: labId(req), categoryId });
          return reply.send({ categoryId, sampleCollectionRoom: null });
        }

        const update = {
          labId: labId(req),
          categoryId,
          sampleCollectionRoom: room,
          updated: { at: Date.now(), by: { id: toObjectId(req.user.id), name: req.user.name } },
        };

        await categoryRoomCol().updateOne({ labId: labId(req), categoryId }, { $set: update }, { upsert: true });

        return reply.send({ categoryId, sampleCollectionRoom: room });
      } catch (err) {
        req.log.error(err);
        return reply.code(500).send({ error: "Failed to update category collection room" });
      }
    },
  );

  // ── PATCH /test-config/:testId/collection-room ─────────────────────────────
  // Sets (or unsets) one test's own room — used when a test needs to deviate
  // from its category's default. Unsetting it (null) makes the test fall
  // back to `effectiveCollectionRoom`'s category-default lookup again.
  fastify.patch("/test-config/:testId/collection-room", { ...updateTestCollectionRoomSchema }, async (req, reply) => {
    try {
      const _id = toObjectId(req.params.testId);
      if (!_id) return reply.code(400).send({ error: "Invalid test ID" });

      const raw = req.body.sampleCollectionRoom;
      const room = typeof raw === "string" && raw.trim() !== "" ? raw.trim() : null;

      const update = {
        sampleCollectionRoom: room,
        updated: { at: Date.now(), by: { id: toObjectId(req.user.id), name: req.user.name } },
      };

      const result = await testCol().updateOne({ _id, labId: labId(req) }, { $set: update });
      if (result.matchedCount === 0) return reply.code(404).send({ error: "Test not found" });

      const updated = await testCol().findOne({ _id, labId: labId(req) });
      return reply.send(updated);
    } catch (err) {
      req.log.error(err);
      return reply.code(500).send({ error: "Failed to update collection room" });
    }
  });

  // ── GET /test-config/test/schema/:testId ──────────────────────────────────
  // testSchemas are global report-format templates (no labId field — not
  // lab-owned data), so this is intentionally NOT scoped by lab. Any lab can
  // use any schema. NOTE: no longer filters on isActive — testSchemas docs
  // don't reliably carry that field, so filtering on it was hiding all formats.
  fastify.get("/test-config/test/schema/:testId", getTestSchemaByTestIdSchema, async (req, reply) => {
    try {
      const testId = toObjectId(req.params.testId);
      if (!testId) return reply.code(400).send({ error: "Invalid test ID" });

      const list = await schemaCol().find({ testId }).toArray();
      return reply.send(list);
    } catch (err) {
      req.log.error(err);
      return reply.code(500).send({ error: "Failed to fetch test schemas" });
    }
  });

  // ── GET /test-config/schema/:schemaId ─────────────────────────────────────
  // Global template lookup by its own _id — not lab-scoped, same reasoning
  // as above.
  fastify.get("/test-config/schema/:schemaId", getSchemaByIdSchema, async (req, reply) => {
    try {
      const _id = toObjectId(req.params.schemaId);
      if (!_id) return reply.code(400).send({ error: "Invalid schema ID" });

      const schema = await schemaCol().findOne({ _id });
      if (!schema) return reply.code(404).send({ error: "Schema not found" });
      return reply.send(schema);
    } catch (err) {
      req.log.error(err);
      return reply.code(500).send({ error: "Failed to fetch schema" });
    }
  });

  // ── PATCH /test-config/:testId/schema ─────────────────────────────────────
  // Attaches / switches / clears the test's report format. Range overrides
  // belong to the format they were made on, so if the format actually changes
  // (different id, or cleared) `schema.overrides` is reset to [] in the same
  // update — no orphaned overrides are left behind. Re-saving the same format
  // leaves overrides untouched.
  fastify.patch("/test-config/:testId/schema", { ...updateTestSchemaIdSchema }, async (req, reply) => {
    try {
      const _id = toObjectId(req.params.testId);
      if (!_id) return reply.code(400).send({ error: "Invalid test ID" });

      const { schemaId } = req.body;
      let resolvedSchemaId = null;
      if (schemaId !== null) {
        resolvedSchemaId = toObjectId(schemaId);
        if (!resolvedSchemaId) return reply.code(400).send({ error: "Invalid schema ID" });

        // Schemas are global templates, not lab-owned — just confirm it
        // exists, no labId ownership check (there's no labId on these docs).
        const schema = await schemaCol().findOne({ _id: resolvedSchemaId });
        if (!schema) return reply.code(404).send({ error: "Schema not found" });
      }

      const current = await testCol().findOne({ _id, labId: labId(req) }, { projection: { schemaId: 1 } });
      if (!current) return reply.code(404).send({ error: "Test not found" });

      const formatChanged = String(current.schemaId ?? "") !== String(resolvedSchemaId ?? "");

      const update = {
        schemaId: resolvedSchemaId,
        updated: { at: Date.now(), by: { id: toObjectId(req.user.id), name: req.user.name } },
      };
      if (formatChanged) update["schema.overrides"] = [];

      const result = await testCol().updateOne({ _id, labId: labId(req) }, { $set: update });
      if (result.matchedCount === 0) return reply.code(404).send({ error: "Test not found" });

      const updated = await testCol().findOne({ _id, labId: labId(req) });
      return reply.send(updated);
    } catch (err) {
      req.log.error(err);
      return reply.code(500).send({ error: "Failed to update test schema" });
    }
  });

  // ── PUT /test-config/:testId/range-override ───────────────────────────────
  // Replaces this field's override entry with exactly the keys sent. If none
  // of standardRange / referenceValue / unit is sent, the entry is removed.
  fastify.put("/test-config/:testId/range-override", { ...saveRangeOverrideSchema }, async (req, reply) => {
    try {
      const _id = toObjectId(req.params.testId);
      if (!_id) return reply.code(400).send({ error: "Invalid test ID" });

      const { sectionName, fieldName, standardRange, referenceValue, unit } = req.body;

      const test = await testCol().findOne({ _id, labId: labId(req) });
      if (!test) return reply.code(404).send({ error: "Test not found" });
      if (!test.schemaId) return reply.code(400).send({ error: "Test has no report format" });

      const entry = { schemaId: test.schemaId, sectionName, fieldName };
      if (standardRange !== undefined) entry.standardRange = standardRange;
      if (referenceValue !== undefined) entry.referenceValue = referenceValue;
      if (unit !== undefined) entry.unit = unit.trim();
      const hasChange = Object.keys(entry).length > 3;

      const kept = (test.schema?.overrides ?? []).filter(
        (o) =>
          !(String(o.schemaId) === String(test.schemaId) && o.sectionName === sectionName && o.fieldName === fieldName),
      );

      await testCol().updateOne(
        { _id, labId: labId(req) },
        {
          $set: {
            "schema.overrides": hasChange ? [...kept, entry] : kept,
            updated: { at: Date.now(), by: { id: toObjectId(req.user.id), name: req.user.name } },
          },
        },
      );

      return reply.send(await testCol().findOne({ _id, labId: labId(req) }));
    } catch (err) {
      req.log.error(err);
      return reply.code(500).send({ error: "Failed to save range override" });
    }
  });
}

export default testConfigRoutes;
