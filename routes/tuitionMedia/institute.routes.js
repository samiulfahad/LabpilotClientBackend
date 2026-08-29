// institutes.routes.js
// Requires: fastify-mongodb (or your own MongoDB client) decorated as fastify.mongo

const OID_PATTERN = "^[0-9a-fA-F]{24}$";

const institutePayloadSchema = {
  type: "object",
  required: ["name"],
  properties: {
    name: { type: "string", minLength: 2, maxLength: 200 },
  },
};

async function instituteRoutes(fastify) {
  const collection = () => fastify.mongo.db.collection("institutes");

  // CREATE
  fastify.post(
    "/institutes",
    { schema: { tags: ["institutes"], summary: "Create an institute", body: institutePayloadSchema } },
    async (req, reply) => {
      const name = req.body.name.trim();

      const existing = await collection().findOne({
        name: { $regex: `^${name}$`, $options: "i" },
      });
      if (existing) {
        return reply.code(409).send({ error: "An institute with this name already exists." });
      }

      const doc = { name, createdAt: new Date(), updatedAt: null };
      const result = await collection().insertOne(doc);
      return reply.code(201).send({ _id: result.insertedId, ...doc });
    },
  );

  // READ (list)
  fastify.get("/institutes", { schema: { tags: ["institutes"], summary: "List institutes" } }, async () => {
    return collection().find({}).sort({ name: 1 }).toArray();
  });

  // READ (single)
  fastify.get(
    "/institutes/:id",
    {
      schema: {
        tags: ["institutes"],
        params: { type: "object", properties: { id: { type: "string", pattern: OID_PATTERN } } },
      },
    },
    async (req, reply) => {
      const { ObjectId } = fastify.mongo;
      const institute = await collection().findOne({ _id: new ObjectId(req.params.id) });
      if (!institute) return reply.code(404).send({ error: "Institute not found." });
      return institute;
    },
  );

  // UPDATE
  fastify.patch(
    "/institutes/:id",
    {
      schema: {
        tags: ["institutes"],
        params: { type: "object", properties: { id: { type: "string", pattern: OID_PATTERN } } },
        body: institutePayloadSchema,
      },
    },
    async (req, reply) => {
      const { ObjectId } = fastify.mongo;
      const name = req.body.name.trim();
      const id = new ObjectId(req.params.id);

      const duplicate = await collection().findOne({
        _id: { $ne: id },
        name: { $regex: `^${name}$`, $options: "i" },
      });
      if (duplicate) {
        return reply.code(409).send({ error: "An institute with this name already exists." });
      }

      const result = await collection().findOneAndUpdate(
        { _id: id },
        { $set: { name, updatedAt: new Date() } },
        { returnDocument: "after" },
      );

      if (!result.value) return reply.code(404).send({ error: "Institute not found." });
      return result.value;
    },
  );

  // DELETE
  fastify.delete(
    "/institutes/:id",
    {
      schema: {
        tags: ["institutes"],
        params: { type: "object", properties: { id: { type: "string", pattern: OID_PATTERN } } },
      },
    },
    async (req, reply) => {
      const { ObjectId } = fastify.mongo;
      const result = await collection().deleteOne({ _id: new ObjectId(req.params.id) });
      if (result.deletedCount === 0) return reply.code(404).send({ error: "Institute not found." });
      return reply.code(200).send({ success: true });
    },
  );
}

export default instituteRoutes;
