// ── routes/billing/billing.js  (client backend) ──────────────────────────────
// Read-only for labs. There is intentionally NO route here that can mark a bill
// as paid. Payments are received manually via bKash and marked paid from the
// internal / super-admin backend, which must call invalidateBillingCache(labId)
// after updating the bill so the lab is unblocked immediately.

import toObjectId from "../../utils/db.js";

const billingStatusSchema = {
  schema: {
    tags: ["Billing"],
    summary: "Get current unpaid bill status for the authenticated lab",
  },
};

const billingHistorySchema = {
  schema: {
    tags: ["Billing"],
    summary: "Get billing history for the authenticated lab (last 24 months)",
  },
};

async function billingRoutes(fastify) {
  const col = () => fastify.mongo.db.collection("billings");

  fastify.addHook("onRequest", fastify.authenticate);

  const requireManageBilling = { onRequest: [fastify.authorize("manageBilling")] };

  // ── GET /billing/status ───────────────────────────────────────────────────
  // Returns the latest unpaid bill for the authenticated lab.
  // Intentionally NOT gated behind "manageBilling" — this powers a banner
  // every logged-in staff member should see, not just billing admins.
  // Backed by billingGuard's cached getBillingStatus (5-min TTL).
  fastify.get("/billing/status", billingStatusSchema, async (req, reply) => {
    try {
      const status = await fastify.getBillingStatus(toObjectId(req.user.labId));

      if (!status.hasUnpaid) return reply.send({ hasUnpaidBill: false });

      return reply.send({
        hasUnpaidBill: true,
        isOverdue: status.blocked,
        bill: {
          id: status.id,
          amount: status.amount,
          dueDate: status.dueDate,
          invoiceCount: status.invoiceCount,
          breakdown: status.breakdown,
          billingPeriodStart: status.billingPeriodStart,
          billingPeriodEnd: status.billingPeriodEnd,
        },
      });
    } catch (err) {
      req.log.error(err);
      return reply.code(500).send({ error: "Failed to fetch billing status" });
    }
  });

  // ── GET /billing/history ──────────────────────────────────────────────────
  // Returns up to 24 months of billing history for the authenticated lab.
  fastify.get("/billing/history", { ...billingHistorySchema, ...requireManageBilling }, async (req, reply) => {
    try {
      const bills = await col()
        .find(
          { labId: toObjectId(req.user.labId) },
          {
            projection: {
              status: 1,
              totalAmount: 1,
              dueDate: 1,
              billingPeriodStart: 1,
              billingPeriodEnd: 1,
              invoiceCount: 1,
              breakdown: 1,
              paidAt: 1,
              paidBy: 1,
            },
          },
        )
        .sort({ billingPeriodStart: -1 })
        .limit(24)
        .toArray();

      return reply.send({ bills });
    } catch (err) {
      req.log.error(err);
      return reply.code(500).send({ error: "Failed to fetch billing history" });
    }
  });
}

export default billingRoutes;
