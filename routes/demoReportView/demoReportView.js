// Client-side (lab-facing) read of demo/sample report data, keyed by
// schemaId. This is intentionally separate from the admin demoReportRoutes
// file — that one is for admins managing demo reports (create/replace/
// delete); this one only lets an authenticated lab user VIEW one, from the
// "প্রিভিউ" button in TestConfigPage's format picker. No write operations
// here at all.
export default async function demoReportViewRoutes(fastify) {
  function col() {
    return fastify.mongo.db.collection("demoReports");
  }

  // Any authenticated lab user can view a demo report for a format — this
  // is just a read-only sample preview, not lab-owned data, so no
  // labId scoping and no extra permission check beyond being logged in.
  fastify.addHook("onRequest", fastify.authenticate);
    fastify.addHook("onRequest", fastify.authorize("manageTestConfig"));

  // GET /report/demo-preview/:schemaId
  fastify.get("/report/demo-preview/:schemaId", async (req, reply) => {
    try {
      const doc = await col().findOne({ schemaId: req.params.schemaId });
      if (!doc) return reply.code(404).send({ error: "Demo report not found for this format" });
      return reply.send(doc);
    } catch (err) {
      req.log.error(err);
      return reply.code(500).send({ error: "Failed to fetch demo report" });
    }
  });
}