import toObjectId from "../../utils/db.js";
import { ALLOWED_PERMISSIONS } from "../staticData/staticData.js";

const cacheInvalidateSchema = {
  schema: {
    params: {
      type: "object",
      required: ["labId"],
      additionalProperties: false,
      properties: {
        labId: { type: "string", pattern: "^[a-fA-F0-9]{24}$" },
      },
    },
  },
};

function verifyInternalSecret(req, reply) {
  const secret = req.headers["x-internal-secret"];
  if (!secret || secret !== process.env.INTERNAL_SECRET) {
    reply.code(403).send({ error: "Forbidden" });
    return false;
  }
  return true;
}

async function internalRoutes(fastify) {
  fastify.post("/internal/billing/cache-invalidate/:labId", cacheInvalidateSchema, async (req, reply) => {
    try {
      if (!verifyInternalSecret(req, reply)) return;

      const labId = toObjectId(req.params.labId);
      if (!labId) return reply.code(400).send({ error: "Invalid labId" });

      fastify.invalidateBillingCache(labId);
      return reply.send({ success: true });
    } catch (err) {
      req.log.error(err);
      return reply.code(500).send({ error: "Cache invalidation failed" });
    }
  });

  // ── GET /internal/permissions ─────────────────────────────────────────────
  fastify.get("/internal/permissions", async (req, reply) => {
    if (!verifyInternalSecret(req, reply)) return;
    return reply.send({ permissions: ALLOWED_PERMISSIONS });
  });
}

export default internalRoutes;
