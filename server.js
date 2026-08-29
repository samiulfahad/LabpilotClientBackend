import Fastify from "fastify";
import cors from "@fastify/cors";
import mongodb from "@fastify/mongodb";
import swagger from "@fastify/swagger";
import swaggerUi from "@fastify/swagger-ui";
import fastifyCookie from "@fastify/cookie";
import dotenv from "dotenv";

// Tuition Media
import tutorCvRoutes from "./routes/tuitionMedia/tutionMedia.routes.js";

// Plugins
import authPlugin from "./plugins/auth.js";
import smsPlugin from "./plugins/sms.js";
import billingGuardPlugin from "./plugins/billingGuard.js";

// Index ensure
import { ensureIndexes } from "./db/indexes.js";

// Auth Routes
import authRoutes from "./routes/auth/auth.js";

// Set Password
import setPasswordRoutes from "./routes/setPassword/setPassword.js";

// Setup Routes
import referrerRoutes from "./routes/setup/referrer.js";
import staffRoutes from "./routes/setup/staff.js";
import testRoutes from "./routes/setup/test.js";
import productRoutes from "./routes/setup/product.js";
import doctorRoutes from "./routes/setup/doctor.js";
import admissionSpaceRoutes from "./routes/setup/admissionSpace.js";

// Help Center Route
import helpCenterRoutes from "./routes/helpCenter/helpCenter.js";


// Invoice / Outdoor Routes
import invoiceRoutes from "./routes/invoice/invoice.js";

// Indoor Patient Routes
import indoorPatientRoutes from "./routes/indoorPatient/indoorPatient.js";

// My Activity Routes
import myActivityRoutes from "./routes/myActivity/myActivity.js";

// Expense Routes
import expenseRoutes from "./routes/expense/expense.js";

// Outdoor Report Routes
import outdoorReportRoutes from "./routes/report/outdoorReports.js";

// Indoor Report Routes
import indoorReportRoutes from "./routes/report/indoorReports.js";

// Daily Report Routes
import cashmemoRoutes from "./routes/dailyReports/cashmemo.js";
import salesReportRoutes from "./routes/dailyReports/salesReport.js";
import expenseReportRoutes from "./routes/dailyReports/expenseReport.js";
import commissionReportRoutes from "./routes/dailyReports/commissionReport.js";
import collectionReportRoutes from "./routes/dailyReports/collectionReport.js";
import discountReportRoutes from "./routes/dailyReports/discountReport.js";

// Account Routes
import accountRoutes from "./routes/account/account.js";

// Billing Routes
import billingRoutes from "./routes/billing/billing.js";

// Static Data Routes
import staticDataRoutes from "./routes/staticData/staticData.js";

// Internal Routes
import internalRoutes from "./routes/internal/internal.js";

dotenv.config();

const fastify = Fastify({
  disableRequestLogging: true,
  logger: {
    transport: {
      target: "pino-pretty",
      options: { ignore: "pid,hostname,level,time,reqId,req,res,responseTime" },
    },
  },
});

// ── 1. Cookies
await fastify.register(fastifyCookie);

// ── 2. CORS
await fastify.register(cors, {
  origin: [
    "https://labpilotpro.com",
    "https://www.labpilotpro.com",
    "http://localhost:5173",
    "http://localhost:5174",
  ],
  methods: ["GET", "POST", "PUT", "DELETE", "PATCH", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"],
  exposedHeaders: ["X-Billing-Due", "X-Billing-Overdue", "X-Billing-Due-Date"],
  credentials: true,
});

// ── 3. MongoDB
await fastify.register(mongodb, {
  forceClose: true,
  url: process.env.MONGODB_URI,
  database: "labpilot",
});

// ── 4. DB indexes
try {
  await ensureIndexes(fastify.mongo.db);
  fastify.log.info("DB indexes ensured");
} catch (err) {
  fastify.log.error({ err }, "Could not ensure DB indexes — aborting");
  process.exit(1);
}

// ── 5. Plugins
await fastify.register(authPlugin);
await fastify.register(smsPlugin);
await fastify.register(billingGuardPlugin);

// ── 6. Swagger
await fastify.register(swagger, {
  openapi: {
    info: {
      title: "LabPilot Lab API",
      description: "Lab-facing REST API",
      version: "1.0.0",
    },
    servers: [{ url: `http://localhost:${process.env.LAB_PORT || 3000}` }],
  },
});

await fastify.register(swaggerUi, {
  routePrefix: "/docs",
  uiConfig: { docExpansion: "list", deepLinking: true },
  staticCSP: true,
});

// ── 7. Routes
const API = "/v1";

// Tuition Media
fastify.register(tutorCvRoutes, { prefix: API });

// Auth
fastify.register(authRoutes, { prefix: API });

// Set Password for new Users
fastify.register(setPasswordRoutes, { prefix: API });

// Daily Reports
fastify.register(cashmemoRoutes, { prefix: API });
fastify.register(salesReportRoutes, { prefix: API });
fastify.register(expenseReportRoutes, { prefix: API });
fastify.register(commissionReportRoutes, { prefix: API });
fastify.register(collectionReportRoutes, { prefix: API });
fastify.register(discountReportRoutes, { prefix: API });

// Expense
fastify.register(expenseRoutes, { prefix: API });

// Referrers
fastify.register(referrerRoutes, { prefix: API });

// Staffs
fastify.register(staffRoutes, { prefix: API });
fastify.register(testRoutes, { prefix: API });
fastify.register(productRoutes, { prefix: API });
fastify.register(invoiceRoutes, { prefix: API });
fastify.register(myActivityRoutes, { prefix: API });

// Outdoor Reports
fastify.register(outdoorReportRoutes, { prefix: API });
// Indoor Reports
fastify.register(indoorReportRoutes, { prefix: API });

fastify.register(accountRoutes, { prefix: API });
fastify.register(billingRoutes, { prefix: API });
fastify.register(doctorRoutes, { prefix: API });
fastify.register(indoorPatientRoutes, { prefix: API });
fastify.register(admissionSpaceRoutes, { prefix: API });
fastify.register(staticDataRoutes, { prefix: API });

// Support Route 
fastify.register(helpCenterRoutes, { prefix: API });

fastify.register(internalRoutes); // no /v1 prefix — internal only

fastify.get("/", async (req, reply) => reply.send("Lab API OK"));

// ── 8. Start
try {
  await fastify.listen({ port: process.env.LAB_PORT || 3000, host: "0.0.0.0" });
} catch (err) {
  fastify.log.error(err);
  process.exit(1);
}
